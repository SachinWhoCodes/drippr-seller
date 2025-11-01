// api/admin/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

/** --- GraphQL --- **/

// Read minimal product info so we can (1) find a default variant, (2) get inventoryItem.id
const PRODUCT_MIN = /* GraphQL */ `
  query ProductMin($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 100) {
        nodes {
          id
          title
          price
          compareAtPrice
          sku
          barcode
          inventoryItem { id tracked }
        }
      }
    }
  }
`;

const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

/**
 * Set absolute on-hand quantities by inventoryItemId(s).
 * Requires a valid SHOPIFY_LOCATION_ID
 */
const SET_ON_HAND = /* GraphQL */ `
  mutation inventorySetOnHandQuantities($input: [InventorySetOnHandQuantitiesInput!]!) {
    inventorySetOnHandQuantities(input: $input) {
      inventoryLevels {
        id
        available
        location { id }
        item { id }
      }
      userErrors { field message }
    }
  }
`;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth (seller) ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid;

    const {
      firestoreId,
      shopifyProductId: shopifyProductIdBody,
      liveVariantId,

      // instant updates
      price,
      compareAtPrice,
      quantity,

      // queued edits for admin
      title,
      description,
      tags,
      images,
      productType,
      vendor,
      variantDraft,
      adminNote,
    } = req.body || {};

    if (!firestoreId) {
      return res.status(400).json({ ok: false, error: "firestoreId is required" });
    }

    // --- read seller's doc ---
    const docRef = adminDb.collection("merchantProducts").doc(firestoreId);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Product not found" });

    const doc = snap.data() || {};
    if (String(doc.merchantId) !== merchantId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const shopifyProductId: string = shopifyProductIdBody || doc.shopifyProductId;
    if (!shopifyProductId) {
      return res.status(400).json({ ok: false, error: "Missing shopifyProductId" });
    }

    // --- fetch minimal product + variants from Shopify ---
    const pRes = await shopifyGraphQL(PRODUCT_MIN, { id: shopifyProductId });
    const pErrors = pRes.errors || pRes.data?.product?.userErrors || [];
    if (pErrors.length) {
      return res.status(400).json({ ok: false, error: Array.isArray(pErrors) ? pErrors.map((e: any) => e.message).join("; ") : "Shopify read failed" });
    }
    const product = pRes.data?.product;
    if (!product) {
      return res.status(404).json({ ok: false, error: "Shopify product not found" });
    }
    const variants: any[] = product.variants?.nodes || [];
    if (!variants.length) {
      return res.status(400).json({ ok: false, error: "Product has no variants on Shopify" });
    }

    // Determine which live variant to instantly update
    const targetVariant = liveVariantId
      ? variants.find((v) => v.id === liveVariantId)
      : variants[0];

    // --- 1) Instant price update (optional) ---
    if (price != null || compareAtPrice != null) {
      const payload = [{
        id: String(targetVariant.id),
        ...(price != null ? { price: String(price) } : {}),
        ...(compareAtPrice != null ? { compareAtPrice: String(compareAtPrice) } : {}),
      }];

      const vRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
        productId: shopifyProductId,
        variants: payload,
      });
      const vErrs = vRes.data?.productVariantsBulkUpdate?.userErrors || [];
      if (vErrs.length) {
        // carry on but surface the error
        console.warn("productVariantsBulkUpdate errors:", vErrs);
        return res.status(400).json({ ok: false, error: vErrs.map((e: any) => e.message).join("; ") });
      }
    }

    // --- 2) Instant stock update (optional) ---
    const locationId = process.env.SHOPIFY_LOCATION_ID || "";
    if (quantity != null && locationId) {
      const inventoryItemId = targetVariant?.inventoryItem?.id;
      if (inventoryItemId) {
        const sRes = await shopifyGraphQL(SET_ON_HAND, {
          input: [{
            inventoryItemId,
            locationId,
            setOnHandQuantity: Number(quantity),
          }],
        });
        const sErrs = sRes.data?.inventorySetOnHandQuantities?.userErrors || [];
        if (sErrs.length) {
          console.warn("inventorySetOnHandQuantities errors:", sErrs);
          return res.status(400).json({ ok: false, error: sErrs.map((e: any) => e.message).join("; ") });
        }
      }
    }

    // --- 3) Queue all other edits for admin & mirror updates locally ---
    const now = Date.now();

    // What we mirror immediately in Firestore:
    const immediatePatch: any = {
      updatedAt: now,
    };
    if (price != null) immediatePatch.price = Number(price);
    if (quantity != null) immediatePatch.stock = Number(quantity);

    // Everything else becomes "update_in_review" for admin to apply in Shopify
    const needsReviewPayload: any = {
      // seller-proposed edits not yet applied on Shopify
      pendingEdits: {
        ...(title != null ? { title } : {}),
        ...(description != null ? { description } : {}),
        ...(Array.isArray(tags) ? { tags } : {}),
        ...(images ? { images } : {}),
        ...(productType !== undefined ? { productType } : {}),
        ...(vendor !== undefined ? { vendor } : {}),
        ...(variantDraft ? { variantDraft } : {}),
        ...(adminNote ? { adminNote } : {}),
      },
      // status flag for your admin queue
      status: "update_in_review",
      updateRequestedAt: now,
    };

    // If nothing in pendingEdits, avoid writing empty object
    const hasPending =
      Object.keys(needsReviewPayload.pendingEdits).length > 0;

    await docRef.set(
      {
        ...immediatePatch,
        ...(hasPending ? needsReviewPayload : {}),
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      productId: shopifyProductId,
      updatedVariantId: targetVariant?.id || null,
      inventoryUpdated: quantity != null && !!locationId,
      note: !locationId && quantity != null
        ? "Quantity stored locally; no SHOPIFY_LOCATION_ID set."
        : undefined,
    });
  } catch (e: any) {
    console.error("update product error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
