// api/webhooks/shopify/fulfillments-create.ts
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
    if (topic !== "fulfillments/create") return res.status(200).send("Ignored topic");

    const payload = JSON.parse(rawBody.toString("utf8"));
    const shopifyOrderId = String(payload.order_id);

    const trackingCompany = payload.tracking_company || null;
    const trackingNumber = payload.tracking_number || null;
    const trackingUrl = payload.tracking_url || null;
    const fulfillmentStatus = payload.status === "success" ? "fulfilled" : "in_progress";
    const deliveryStatus = payload.delivery_status || null; // may be null here

    const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

    const { adminDb } = getAdmin();

    // idempotency
    const evRef = adminDb.collection("webhookEvents").doc(webhookId || `fulfillments_create_${shopifyOrderId}`);
    const evSnap = await evRef.get();
    if (!evSnap.exists) await evRef.set({ topic, shopifyOrderId, receivedAt: Date.now() });

    // map SKUs → merchantProducts
    const skus = Array.from(
      new Set(lineItems.map((li: any) => String(li.sku || "")).filter(Boolean))
    );

    const skuToMp = new Map<string, { id: string; merchantId: string }>();
    const chunk = <T,>(arr: T[], size: number) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

    for (const part of chunk(skus, 10)) {
      const snap = await adminDb.collection("merchantProducts").where("sku", "in", part).get();
      snap.forEach((d) => skuToMp.set(String(d.get("sku")), { id: d.id, merchantId: d.get("merchantId") }));
    }

    // group items by merchant
    const byMerchant = new Map<string, any[]>();
    for (const li of lineItems) {
      const sku = String(li.sku || "");
      const mp = skuToMp.get(sku);
      if (!mp) continue;
      const arr = byMerchant.get(mp.merchantId) || [];
      arr.push({ sku, quantity: Number(li.quantity || 0), title: li.title || "" });
      byMerchant.set(mp.merchantId, arr);
    }

    // write shipments per merchant
    const batch = adminDb.batch();
    byMerchant.forEach((items, merchantId) => {
      const orderDocId = `${shopifyOrderId}_${merchantId}`;
      const ref = adminDb.collection("orders").doc(orderDocId);
      batch.set(
        ref,
        {
          updatedAt: Date.now(),
          fulfillmentStatus,
          shipments: FieldValue.arrayUnion({
            at: Date.now(),
            trackingCompany,
            trackingNumber,
            trackingUrl,
            status: deliveryStatus || fulfillmentStatus, // best available
            items, // minimal list {sku, qty, title}
          }),
          audit: FieldValue.arrayUnion({
            at: Date.now(),
            type: "fulfillments/create",
            trackingNumber,
          }),
        },
        { merge: true }
      );
    });

    await batch.commit();
    return res.status(200).send("ok");
  } catch (err: any) {
    console.error("fulfillments-create webhook error:", err?.message || err);
    return res.status(500).send("server error");
  }
}
