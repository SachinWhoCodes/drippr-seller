// api/admin/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

// ---- Shopify bits (Admin API, not Storefront!) ----
const PRODUCT_VARIANTS_QUERY = /* GraphQL */ `
  query product($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 100) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          barcode
          inventoryQuantity
          inventoryItem { id tracked }
        }
      }
    }
  }
`;

const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate(
    $productId: ID!, 
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

// optional – will push absolute qty only if you have a default location
const INVENTORY_SET_ON_HAND = /* GraphQL */ `
  mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

export default async function handler(req: any, res: any) {
  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });

    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;

    if (req.method === "GET") {
      // /api/admin/products/update?id=<firestoreDocId>&live=1
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

      const snap = await adminDb.collection("merchantProducts").doc(id).get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

      const doc = snap.data() || {};
      // ensure the logged-in merchant can read their own product
      if (doc.merchantId && doc.merchantId !== uid) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      let liveVariants: any[] | undefined = undefined;
      if (req.query.live) {
        // NOTE: Admin API, price/compareAtPrice fields – do NOT use priceV2/weight, and no Storefront types.
        if (doc.shopifyProductId) {
          const r = await shopifyGraphQL(PRODUCT_VARIANTS_QUERY, { id: doc.shopifyProductId });
          const pv = r?.data?.product?.variants?.nodes || [];
          liveVariants = pv.map((v: any) => ({
            id: v.id,
            title: v.title,
            sku: v.sku,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            barcode: v.barcode,
            inventoryQuantity: v.inventoryQuantity,
            tracked: !!v.inventoryItem?.tracked,
          }));
        }
      }

      return res.status(200).json({
        ok: true,
        product: { id: snap.id, ...doc },
        liveVariants,
      });
    }

    if (req.method === "POST") {
      // Expect: { id, price?, stockQty?, title?, description?, productType?, tags?, vendor?, compareAtPrice?, barcode?, weightGrams?, variantDraft? }
      const body = req.body || {};
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

      const ref = adminDb.collection("merchantProducts").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });
      const doc = snap.data() || {};

      // seller can only touch their own doc
      if (doc.merchantId && doc.merchantId !== uid) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const updates: any = { updatedAt: Date.now() };
      let adminNeedsReview = false;

      // --- Instant pushes to Shopify (price / stock) ---
      const shopifyProductId: string | undefined = doc.shopifyProductId;
      const defaultVariantId: string | undefined = (doc.shopifyVariantIds || [])[0];

      // 1) Price (instant)
      if (defaultVariantId && body.price != null && body.price !== "") {
        const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
          productId: shopifyProductId,
          variants: [{ id: defaultVariantId, price: String(body.price) }],
        });
        const errors = updateRes?.data?.productVariantsBulkUpdate?.userErrors || [];
        if (errors.length) return res.status(400).json({ ok: false, error: errors.map((e: any) => e.message).join("; ") });
        updates.price = Number(body.price);
      }

      // 2) Stock (instant if you set a location)
      if (body.stockQty != null && body.stockQty !== "") {
        updates.stock = Number(body.stockQty);

        const locationId = process.env.SHOPIFY_LOCATION_ID;
        const inventoryItemId: string | undefined = doc.inventoryItemId; // set this in your create flow; else we can’t push absolute qty

        if (locationId && inventoryItemId) {
          try {
            const invRes = await shopifyGraphQL(INVENTORY_SET_ON_HAND, {
              input: {
                reason: "correction",
                setQuantities: [{ inventoryItemId, locationId, quantity: Number(body.stockQty) }],
              },
            });
            const invErrors = invRes?.data?.inventorySetOnHandQuantities?.userErrors || [];
            if (invErrors.length) {
              // don’t fail the whole request; just log and keep local
              console.warn("inventorySetOnHandQuantities errors:", invErrors);
            }
          } catch (e) {
            console.warn("inventorySetOnHandQuantities failed:", e);
          }
        }
      }

      // --- Everything else => admin review ---
      const reviewFields = [
        "title",
        "description",
        "productType",
        "tags",
        "vendor",
        "compareAtPrice",
        "barcode",
        "weightGrams",
        "variantDraft",
      ] as const;

      const changedForReview: Record<string, any> = {};
      for (const f of reviewFields) {
        if (f in body && body[f] !== undefined) {
          changedForReview[f] = body[f];
        }
      }
      if (Object.keys(changedForReview).length) {
        adminNeedsReview = true;
        updates.pendingUpdates = {
          ...(doc.pendingUpdates || {}),
          ...changedForReview,
        };
        updates.status = "update_in_review";
      }

      await ref.set(updates, { merge: true });

      return res.status(200).json({
        ok: true,
        review: adminNeedsReview,
        note:
          adminNeedsReview
            ? "Price/stock pushed instantly (if provided). Other changes queued for admin review."
            : "Updated instantly.",
      });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    console.error("update endpoint error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
