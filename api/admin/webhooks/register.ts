// api/admin/webhooks/register.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";

export default async function handler(req: any, res: any) {
  // POST only (keeps it private; you can add a one-off GET bypass if you like)
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { adminAuth } = getAdmin();

    // require a logged-in user
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    await adminAuth.verifyIdToken(token);

    const base = process.env.APP_BASE_URL;
    const shop = process.env.SHOPIFY_STORE_DOMAIN!;
    const api = process.env.SHOPIFY_API_VERSION || "2025-01";
    const adminToken = process.env.SHOPIFY_ADMIN_TOKEN!;

    if (!base) return res.status(400).json({ ok: false, error: "APP_BASE_URL not set" });

    const address = `${base.replace(/\/$/, "")}/api/webhooks/shopify/orders-create`;

    // 1) Check if it already exists
    const lookup = await fetch(`https://${shop}/admin/api/${api}/webhooks.json?topic=orders/create`, {
      headers: {
        "X-Shopify-Access-Token": adminToken,
        "Content-Type": "application/json",
      },
    });
    const existing = await lookup.json().catch(() => ({} as any));
    if (lookup.ok) {
      const found = (existing.webhooks || []).find((w: any) => w.address === address);
      if (found) {
        return res.status(200).json({ ok: true, already: true, address, id: found.id });
      }
    }

    // 2) Create webhook (REST)
    const resp = await fetch(`https://${shop}/admin/api/${api}/webhooks.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook: {
          topic: "orders/create",
          address,
          format: "json",
        },
      }),
    });

    const data = await resp.json().catch(() => ({} as any));
    if (!resp.ok) {
      return res.status(400).json({ ok: false, error: data?.errors || data });
    }
    return res.status(200).json({ ok: true, id: data?.webhook?.id, address });
  } catch (e: any) {
    console.error("webhook register error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
