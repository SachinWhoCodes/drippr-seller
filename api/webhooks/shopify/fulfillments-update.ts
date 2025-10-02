// api/webhooks/shopify/fulfillments-update.ts
import crypto from "node:crypto";
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

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

    const hmacHeader = String(req.headers["x-shopify-hmac-sha256"] || "");
    const topic = String(req.headers["x-shopify-topic"] || "");
    const webhookId = String(req.headers["x-shopify-webhook-id"] || "");
    const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (computed !== hmacHeader) return res.status(401).send("HMAC mismatch");
    if (topic !== "fulfillments/update") return res.status(200).send("Ignored topic");

    const payload = JSON.parse(rawBody.toString("utf8"));
    const shopifyOrderId = String(payload.order_id);

    const trackingCompany = payload.tracking_company || null;
    const trackingNumber = payload.tracking_number || null;
    const trackingUrl = payload.tracking_url || null;
    const deliveryStatus = payload.delivery_status || null; // e.g. "in_transit", "delivered"

    const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

    const { adminDb } = getAdmin();

    // idempotency
    const evRef = adminDb.collection("webhookEvents").doc(webhookId || `fulfillments_update_${shopifyOrderId}`);
    const evSnap = await evRef.get();
    if (!evSnap.exists) await evRef.set({ topic, shopifyOrderId, receivedAt: Date.now() });

    // map SKUs → merchant
    const skus = Array.from(new Set(lineItems.map((li: any) => String(li.sku || "")).filter(Boolean)));
    const skuToMp = new Map<string, { merchantId: string }>();
    const chunk = <T,>(arr: T[], size: number) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
    for (const part of chunk(skus, 10)) {
      const snap = await adminDb.collection("merchantProducts").where("sku", "in", part).get();
      snap.forEach((d) => skuToMp.set(String(d.get("sku")), { merchantId: d.get("merchantId") }));
    }

    const byMerchant = new Map<string, any[]>();
    for (const li of lineItems) {
      const sku = String(li.sku || "");
      const mp = skuToMp.get(sku);
      if (!mp) continue;
      const arr = byMerchant.get(mp.merchantId) || [];
      arr.push({ sku, quantity: Number(li.quantity || 0), title: li.title || "" });
      byMerchant.set(mp.merchantId, arr);
    }

    const batch = adminDb.batch();
    byMerchant.forEach((items, merchantId) => {
      const ref = adminDb.collection("orders").doc(`${shopifyOrderId}_${merchantId}`);
      batch.set(
        ref,
        {
          updatedAt: Date.now(),
          shipments: FieldValue.arrayUnion({
            at: Date.now(),
            trackingCompany,
            trackingNumber,
            trackingUrl,
            status: deliveryStatus,
            items,
          }),
          // if delivered, mark fulfillmentStatus for convenience
          ...(deliveryStatus === "delivered" ? { fulfillmentStatus: "fulfilled" } : {}),
          audit: FieldValue.arrayUnion({
            at: Date.now(),
            type: "fulfillments/update",
            trackingNumber,
            deliveryStatus,
          }),
        },
        { merge: true }
      );
    });

    await batch.commit();
    return res.status(200).send("ok");
  } catch (err: any) {
    console.error("fulfillments-update webhook error:", err?.message || err);
    return res.status(500).send("server error");
  }
}
