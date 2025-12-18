// api/webhooks/shopify/orders-create.ts
import crypto from "node:crypto";
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

// If this is a Next.js pages/api route, this is REQUIRED for raw body HMAC verification.
// (Safe to keep even if not used by your runtime.)
export const config = {
  api: {
    bodyParser: false,
  },
};

// Read raw body for HMAC verification
async function readRawBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function chunk<T>(arr: T[], size: number) {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );
}

function toNumber(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeVerifyShopifyHmac(rawBody: Buffer, secret: string, hmacHeader: string) {
  if (!secret) return false;
  if (!hmacHeader) return false;

  // Shopify sends base64 HMAC of raw body.
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest(); // Buffer
  let headerBuf: Buffer;

  try {
    headerBuf = Buffer.from(String(hmacHeader), "base64");
  } catch {
    return false;
  }

  if (headerBuf.length !== computed.length) return false;
  return crypto.timingSafeEqual(computed, headerBuf);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  if (!secret) return res.status(500).send("Webhook secret not configured");

  try {
    const rawBody = await readRawBody(req);

    // 1) Verify HMAC + topic
    const hmacHeader = String(req.headers["x-shopify-hmac-sha256"] || "");
    const topic = String(req.headers["x-shopify-topic"] || "");
    const webhookId = String(req.headers["x-shopify-webhook-id"] || "");

    const ok = safeVerifyShopifyHmac(rawBody, secret, hmacHeader);
    if (!ok) return res.status(401).send("HMAC mismatch");

    if (topic !== "orders/create") return res.status(200).send("Ignored topic");

    // 2) Parse payload
    const payload = JSON.parse(rawBody.toString("utf8"));
    const shopifyOrderId = String(payload.id || "");
    if (!shopifyOrderId) return res.status(400).send("Missing order id");

    const orderNumber = payload.name || payload.order_number || shopifyOrderId;

    const createdAt = payload.created_at
      ? new Date(payload.created_at).getTime()
      : Date.now();

    const currency =
      payload.currency ||
      payload.total_price_set?.shop_money?.currency_code ||
      "INR";

    const financialStatus = payload.financial_status || "pending";
    const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

    const customerEmail =
      payload.customer?.email ||
      payload.email ||
      payload.contact_email ||
      payload.customer_email ||
      null;

    const { adminDb } = getAdmin();

    // 3) Build product lookup maps (SKU primary, variant numeric fallback)
    const skus: string[] = lineItems
      .map((li: any) => String(li?.sku || "").trim())
      .filter(Boolean);

    const variantNums: string[] = lineItems
      .map((li: any) => (li?.variant_id != null ? String(li.variant_id) : ""))
      .filter(Boolean);

    const skuToProduct = new Map<string, any>();
    const variantNumToProduct = new Map<string, any>();

    // a) match by SKU
    for (const part of chunk([...new Set(skus)], 10)) {
      if (!part.length) continue;
      const snap = await adminDb
        .collection("merchantProducts")
        .where("sku", "in", part)
        .get();

      snap.forEach((doc: any) => {
        skuToProduct.set(String(doc.get("sku")), { id: doc.id, ...(doc.data() as any) });
      });
    }

    // b) fallback: match by variant_id (REST numeric) stored as shopifyVariantNumericIds
    for (const part of chunk([...new Set(variantNums)], 10)) {
      if (!part.length) continue;

      const snap = await adminDb
        .collection("merchantProducts")
        .where("shopifyVariantNumericIds", "array-contains-any", part)
        .get();

      snap.forEach((doc: any) => {
        const ids =
          ((doc.get("shopifyVariantNumericIds") as (string | number)[] | undefined) ??
            []) as (string | number)[];

        const data = { id: doc.id, ...(doc.data() as any) };
        for (const n of ids) variantNumToProduct.set(String(n), data);
      });
    }

    // 4) Group line items by merchant
    const byMerchant = new Map<string, { items: any[]; subtotal: number }>();

    for (const li of lineItems) {
      const sku = String(li?.sku || "").trim();
      const variantNum = li?.variant_id != null ? String(li.variant_id) : "";

      let mp = sku ? skuToProduct.get(sku) : undefined;
      if (!mp && variantNum) mp = variantNumToProduct.get(variantNum);
      if (!mp) continue; // not a marketplace item we manage

      const merchantId = String(mp.merchantId || "");
      if (!merchantId) continue;

      const qty = toNumber(li?.quantity, 0);

      // Shopify line item price often comes as string.
      const unitPrice =
        li?.price != null
          ? toNumber(li.price, 0)
          : toNumber(li?.price_set?.shop_money?.amount, 0);

      const lineTotal = unitPrice * qty;

      const bucket = byMerchant.get(merchantId) || { items: [], subtotal: 0 };
      bucket.items.push({
        line_item_id: li?.id ?? null,
        title: li?.title || "",
        sku: sku || (variantNum ? `v:${variantNum}` : ""),
        quantity: qty,
        price: unitPrice,
        total: Number(lineTotal.toFixed(2)),
        variant_id: variantNum || null,
        product_id: li?.product_id ?? null,
      });
      bucket.subtotal += lineTotal;
      byMerchant.set(merchantId, bucket);
    }

    // 5) SAFE idempotency + write everything atomically
    // We MUST prevent duplicate merchantStats increments.
    const eventId = webhookId || `order_${shopifyOrderId}`;
    const eventRef = adminDb.collection("webhookEvents").doc(eventId);

    const THREE_HOURS = 3 * 60 * 60 * 1000;

    let alreadyProcessed = false;

    await adminDb.runTransaction(async (tx: any) => {
      const evSnap = await tx.get(eventRef);
      if (evSnap.exists) {
        alreadyProcessed = true;
        return;
      }

      // mark event in SAME transaction to avoid:
      // - missing orders when batch fails
      // - duplicate stats increments on retries
      tx.set(eventRef, {
        topic,
        shopifyOrderId,
        receivedAt: Date.now(),
        merchantsCount: byMerchant.size,
      });

      // If no matching marketplace items, we still record the event
      // to avoid repeated retries forever.
      if (byMerchant.size === 0) {
        tx.set(
          eventRef,
          { note: "no matching marketplace items" },
          { merge: true }
        );
        return;
      }

      for (const [merchantId, group] of byMerchant.entries()) {
        const orderDocId = `${shopifyOrderId}_${merchantId}`;
        const orderRef = adminDb.collection("orders").doc(orderDocId);

        tx.set(orderRef, {
          // existing fields
          shopifyOrderId,
          orderNumber,
          merchantId,
          createdAt,
          updatedAt: Date.now(),
          currency,
          financialStatus,
          lineItems: group.items,
          subtotal: Number(group.subtotal.toFixed(2)),
          status: "open",

          // helpful shortcut (UI can use this later)
          customerEmail,

          raw: payload.customer
            ? { customer: { id: payload.customer.id, email: payload.customer.email } }
            : {},

          // ✅ NEW WORKFLOW FIELDS (your requested functionality starts here)
          workflowStatus: "vendor_pending",
          vendorAcceptBy: createdAt + THREE_HOURS,
          vendorAcceptedAt: null,
          adminPlanBy: null,
          adminPlannedAt: null,
          pickupPlan: null,
          deliveryPartner: null,
          dispatchedAt: null,
          invoice: { status: "none" },

          workflowTimeline: [
            {
              at: Date.now(),
              type: "vendor_pending",
              note: "Order received; awaiting vendor acceptance",
            },
          ],
        });

        // keep existing stats logic (but now protected by idempotency transaction)
        const statsRef = adminDb.collection("merchantStats").doc(merchantId);
        tx.set(
          statsRef,
          {
            merchantId,
            ordersCount: FieldValue.increment(1),
            revenue: FieldValue.increment(Number(group.subtotal.toFixed(2))),
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      }
    });

    if (alreadyProcessed) return res.status(200).send("Already processed");
    return res.status(200).send("ok");
  } catch (err: any) {
    console.error("orders-create webhook error:", err?.message || err);
    return res.status(500).send("server error");
  }
}

