// api/admin/webhooks/register.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

// GraphQL to create webhook subscriptions
const WEBHOOK_SUB_CREATE = /* GraphQL */ `
  mutation webhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id format endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
      userErrors { field message }
    }
  }
`;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminAuth } = getAdmin();
    // Require a logged-in user (you can restrict further to an admin UID if you like)
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    await adminAuth.verifyIdToken(token);

    const base = process.env.APP_BASE_URL;
    if (!base) return res.status(400).json({ ok: false, error: "APP_BASE_URL not set" });

    const callbackUrl = `${base.replace(/\/$/, "")}/api/webhooks/shopify/orders-create`;

    const create = await shopifyGraphQL(WEBHOOK_SUB_CREATE, {
      topic: "ORDERS_CREATE",
      webhookSubscription: {
        format: "JSON",
        endpoint: { callbackUrl },
      },
    });

    const errs = create.data?.webhookSubscriptionCreate?.userErrors || [];
    if (errs.length) {
      return res.status(400).json({ ok: false, error: errs.map((e: any) => e.message).join("; ") });
    }

    const ws = create.data.webhookSubscriptionCreate.webhookSubscription;
    return res.status(200).json({ ok: true, id: ws.id, callbackUrl: ws.endpoint?.callbackUrl });
  } catch (e: any) {
    console.error("webhook register error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
