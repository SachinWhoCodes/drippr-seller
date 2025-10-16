// api/webhooks/shopify/orders-create.ts
import crypto from "node:crypto";
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

// Read raw body for HMAC verification
async function readRawBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// small helper
const chunk = <T,>(arr: T[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  if (!secret) return res.status(500).send("Webhook secret not configured");

  try {
    const rawBody = await readRawBody(req);

    // 1) Verify HMAC
    const hmacHeader = String(req.headers["x-shopify-hmac-sha256"] || "");
    const topic = String(req.headers["x-shopify-topic"] || "");
    const webhookId = String(req.headers["x-shopify-webhook-id"] || "");
    const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (computed !== hmacHeader) return res.status(401).send("HMAC mismatch");
    if (topic !== "orders/create") return res.status(200).send("Ignored topic");

    // 2) Parse payload
    const payload = JSON.parse(rawBody.toString("utf8"));
    const shopifyOrderId = String(payload.id);
    const orderNumber = payload.name || payload.order_number || shopifyOrderId;
    const createdAt = payload.created_at ? new Date(payload.created_at).getTime() : Date.now();
    const currency =
      payload.currency || (payload.total_price_set?.shop_money?.currency_code ?? "INR");
    const financialStatus = payload.financial_status || "pending";
    const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

    const { adminDb } = getAdmin();

    // 3) Idempotency
    const eventId = webhookId || `order_${shopifyOrderId}`;
    const eventRef = adminDb.collection("webhookEvents").doc(eventId);
    const eventSnap = await eventRef.get();
    if (eventSnap.exists) return res.status(200).send("Already processed");
    await eventRef.set({ topic, shopifyOrderId, receivedAt: Date.now() });

    // 4) Prepare lookups: by SKU and by variant_id (numeric)
    const skus: string[] = lineItems.map((li: any) => String(li.sku || "")).filter(Boolean);
    const variantNums: string[] = lineItems
      .map((li: any) => (li.variant_id != null ? String(li.variant_id) : ""))
      .filter(Boolean);

    const skuToProduct = new Map<string, any>();
    const variantNumToProduct = new Map<string, any>();

    // a) match by SKU (we set variant.sku = mp_xxx)
    for (const part of chunk([...new Set(skus)], 10)) {
      if (!part.length) continue;
      const snap = await adminDb.collection("merchantProducts").where("sku", "in", part).get();
      snap.forEach((doc) => skuToProduct.set(doc.get("sku"), { id: doc.id, ...doc.data() }));
    }

    // b) fallback: match by variant_id (REST numeric) stored as shopifyVariantNumericIds
    for (const part of chunk([...new Set(variantNums)], 10)) {
      if (!part.length) continue;

      const snap = await adminDb
        .collection("merchantProducts")
        .where("shopifyVariantNumericIds", "array-contains-any", part)
        .get();

      snap.forEach((doc) => {
        // ✅ Read the array in a typed way so TS is happy
        const ids = (doc.get("shopifyVariantNumericIds") as (string | number)[] | undefined) ?? [];

        // It's fine to keep the rest as 'any' for spreading
        const data = { id: doc.id, ...(doc.data() as any) };

        for (const n of ids) {
          variantNumToProduct.set(String(n), data);
        }
      });
    }


    // 5) Group line items by merchant
    const byMerchant = new Map<string, { items: any[]; subtotal: number }>();

    for (const li of lineItems) {
      const sku = String(li.sku || "");
      const variantNum = li.variant_id != null ? String(li.variant_id) : "";
      let mp = sku ? skuToProduct.get(sku) : undefined;
      if (!mp && variantNum) mp = variantNumToProduct.get(variantNum);
      if (!mp) continue; // not a marketplace item we manage

      const merchantId = String(mp.merchantId);
      const qty = Number(li.quantity || 0);
      const unitPrice =
        li.price != null ? Number(li.price) : Number(li.price_set?.shop_money?.amount || 0);
      const lineTotal = unitPrice * qty;

      const bucket = byMerchant.get(merchantId) || { items: [], subtotal: 0 };
      bucket.items.push({
        title: li.title,
        sku: sku || `v:${variantNum}`,
        quantity: qty,
        price: unitPrice,
        total: lineTotal,
        variant_id: variantNum,
        product_id: li.product_id,
      });
      bucket.subtotal += lineTotal;
      byMerchant.set(merchantId, bucket);
    }

    // 6) Write per-merchant order + bump stats
    const batch = adminDb.batch();
    for (const [merchantId, group] of byMerchant.entries()) {
      const orderDocId = `${shopifyOrderId}_${merchantId}`;
      const orderRef = adminDb.collection("orders").doc(orderDocId);
      batch.set(orderRef, {
        id: orderDocId,
        shopifyOrderId,
        orderNumber,
        merchantId,
        createdAt,
        currency,
        financialStatus,
        lineItems: group.items,
        subtotal: Number(group.subtotal.toFixed(2)),
        status: "open",
        raw: payload.customer
          ? { customer: { id: payload.customer.id, email: payload.customer.email } }
          : {},
      });

      const statsRef = adminDb.collection("merchantStats").doc(merchantId);
      batch.set(
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

    await batch.commit();

    if (byMerchant.size === 0) await eventRef.update({ note: "no matching mp items" });

    return res.status(200).send("ok");
  } catch (err: any) {
    console.error("orders-create webhook error:", err?.message || err);
    return res.status(500).send("server error");
  }
}
