// api/admin/queue/approve.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

type Decoded = { uid: string; email?: string; isAdmin?: boolean; admin?: boolean; role?: string };

async function requireAdmin(decoded: Decoded, adminDb: FirebaseFirestore.Firestore) {
  if (decoded?.isAdmin || decoded?.admin || decoded?.role === "admin") return;
  const doc = await adminDb.collection("admins").doc(decoded.uid).get();
  if (doc.exists && doc.get("enabled") !== false) return;
  throw new Error("not_admin");
}

// Ensure product is ACTIVE (Shopify status)
const PRODUCT_UPDATE = /* GraphQL */ `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }
`;

// Publish to a Publication (Online Store, etc.) if provided
const PUBLISHABLE_PUBLISH = /* GraphQL */ `
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminAuth, adminDb } = getAdmin();

    // auth
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = (await adminAuth.verifyIdToken(token)) as Decoded;

    await requireAdmin(decoded, adminDb);

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "Missing product id" });

    const docRef = adminDb.collection("merchantProducts").doc(String(id));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

    const data = snap.data() as any;
    const shopifyId: string | undefined = data.shopifyProductId;
    const alreadyActive = data.status === "active";

    // Best-effort publish + set ACTIVE on Shopify
    if (shopifyId) {
      // 1) set product status ACTIVE (non-fatal if it fails)
      try {
        const upd = await shopifyGraphQL(PRODUCT_UPDATE, {
          input: { id: shopifyId, status: "ACTIVE" },
        });
        const errs = upd.data?.productUpdate?.userErrors || [];
        if (errs.length) console.warn("productUpdate errors:", errs);
      } catch (err) {
        console.warn("productUpdate failed:", err instanceof Error ? err.message : String(err));
      }

      // 2) publish to given publication id (optional)
      const publicationId = process.env.SHOPIFY_PUBLICATION_ID;
      if (publicationId) {
        try {
          const pub = await shopifyGraphQL(PUBLISHABLE_PUBLISH, {
            id: shopifyId,
            input: [{ publicationId }],
          });
          const perrs = pub.data?.publishablePublish?.userErrors || [];
          if (perrs.length) console.warn("publishablePublish errors:", perrs);
        } catch (err) {
          console.warn("publishablePublish failed:", err instanceof Error ? err.message : String(err));
        }
      }
    } else {
      console.warn("approve: missing shopifyProductId on", id);
    }

    // update Firestore
    await docRef.set(
      {
        status: "active",
        approvedAt: Date.now(),
        approvedBy: { uid: decoded.uid, email: decoded.email || null },
        // clear any previous rejection
        rejectedAt: null,
        rejectedBy: null,
        rejectReason: null,
      },
      { merge: true }
    );

    // (Optional) notify seller via a collection or a push mechanism here

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg === "not_admin") return res.status(403).json({ ok: false, error: "Admin only" });
    console.error("queue/approve error:", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
}