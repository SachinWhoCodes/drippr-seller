// api/webhooks/shopify/orders-create.ts
import crypto from "node:crypto";
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

// Read the raw body for HMAC verification
async function readRawBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

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
    if (computed !== hmacHeader) {
      console.warn("HMAC mismatch");
      return res.status(401).send("HMAC mismatch");
    }
    if (topic !== "orders/create") {
      // (Optional) accept other topics later
      return res.status(200).send("Ignored topic");
    }

    // 2) Parse payload
    const payload = JSON.parse(rawBody.toString("utf8"));
    const shopifyOrderId = String(payload.id);
    const orderNumber = payload.name || payload.order_number || shopifyOrderId;
    const createdAt = payload.created_at ? new Date(payload.created_at).getTime() : Date.now();
    const currency = payload.currency || (payload.total_price_set?.shop_money?.currency_code ?? "INR");
    const financialStatus = payload.financial_status || "pending";
    const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

    const { adminDb } = getAdmin();

    // 3) Idempotency: if we’ve already processed this webhook ID, exit
    const eventId = webhookId || `order_${shopifyOrderId}`;
    const eventRef = adminDb.collection("webhookEvents").doc(eventId);
    const eventSnap = await eventRef.get();
    if (eventSnap.exists) {
      return res.status(200).send("Already processed");
    }
    await eventRef.set({ topic, shopifyOrderId, receivedAt: Date.now() });

    // 4) Build SKU list & fetch merchantProducts by sku in chunks of 10
    const skus: string[] = lineItems.map((li: any) => String(li.sku || "")).filter(Boolean);
    const skuToProduct: Map<string, any> = new Map();

    const chunk = <T,>(arr: T[], size: number) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

    for (const part of chunk(Array.from(new Set(skus)), 10)) {
      const snap = await adminDb.collection("merchantProducts").where("sku", "in", part).get();
      snap.forEach((doc) => skuToProduct.set(doc.get("sku"), { id: doc.id, ...doc.data() }));
    }

    // 5) Group line items by merchant
    const byMerchant = new Map<
      string,
      { items: any[]; subtotal: number }
    >();

    for (const li of lineItems) {
      const sku = String(li.sku || "");
      if (!sku) continue;
      const mp = skuToProduct.get(sku);
      if (!mp) continue; // not a marketplace product
      const merchantId = String(mp.merchantId);
      const qty = Number(li.quantity || 0);
      const unitPrice = li.price != null ? Number(li.price) : Number(li.price_set?.shop_money?.amount || 0);
      const lineTotal = unitPrice * qty;

      const bucket = byMerchant.get(merchantId) || { items: [], subtotal: 0 };
      bucket.items.push({
        title: li.title,
        sku,
        quantity: qty,
        price: unitPrice,
        total: lineTotal,
        variant_id: li.variant_id,
        product_id: li.product_id,
      });
      bucket.subtotal += lineTotal;
      byMerchant.set(merchantId, bucket);
    }

    // 6) Write per-merchant order docs + bump merchantStats
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
        status: "open", // you can update via fulfillments later
        raw: {
          // minimal reference; avoid storing the whole payload
          customer: payload.customer ? { id: payload.customer.id, email: payload.customer.email } : null,
        },
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
    return res.status(200).send("ok");
  } catch (err: any) {
    console.error("orders-create webhook error:", err?.message || err);
    return res.status(500).send("server error");
  }
}
