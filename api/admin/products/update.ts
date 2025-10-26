// api/seller/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

/**
 * ENV you should set:
 * - SHOPIFY_LOCATION_ID: your fulfillment location GID (e.g. gid://shopify/Location/123456789)
 *   If missing, inventory updates will be skipped (we still log the request in changeRequests).
 */
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID || "";

/* --------------------------------- GQL ---------------------------------- */

// Get product details incl. options, variants (price + inventoryItem + levels)
const PRODUCT_DETAILS = /* GraphQL */ `
  query productDetails($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      options { name values }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          barcode
          weight
          selectedOptions { name value }
          price
          priceV2 { amount currencyCode }
          inventoryItem {
            id
            tracked
            inventoryLevels(first: 10) {
              nodes {
                id
                location { id name }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Bulk update variant prices (and limited inventoryItem fields)
const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

// Absolute set of on-hand inventory at a location
const INVENTORY_SET_ON_HAND = /* GraphQL */ `
  mutation inventorySetOnHandQuantities($input: [InventorySetOnHandQuantityInput!]!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
    }
  }
`;

/* ------------------------------- Utilities ------------------------------- */

function moneyToNumber(n: any): number | undefined {
  if (n == null) return undefined;
  if (typeof n === "number") return n;
  if (typeof n === "string") return Number(n);
  if (n && typeof n === "object") {
    // MoneyV2
    if (n.amount != null) return Number(n.amount);
  }
  return undefined;
}

function getBearer(req: any): string {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function bad(res: any, code: number, msg: string) {
  return res.status(code).json({ ok: false, error: msg });
}

/**
 * Extract "available" quantity for a given location from inventoryLevels node list.
 */
function readAvailableAtLocation(levels: any[], locationId: string): number | undefined {
  if (!Array.isArray(levels) || !locationId) return undefined;
  for (const lvl of levels) {
    const locId = lvl?.location?.id;
    if (locId === locationId) {
      const q = Array.isArray(lvl?.quantities) ? lvl.quantities.find((x: any) => x?.name === "available") : null;
      if (q && q.quantity != null) return Number(q.quantity);
    }
  }
  return undefined;
}

/* -------------------------------- Handler -------------------------------- */

export default async function handler(req: any, res: any) {
  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const token = getBearer(req);
    if (!token) return bad(res, 401, "Missing Authorization");
    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;

    if (req.method === "GET") {
      // GET /api/seller/products/update?op=details&id=...
      const op = String(req.query.op || "");
      if (op !== "details") return bad(res, 400, "Unsupported op");
      const docId = String(req.query.id || "");
      if (!docId) return bad(res, 400, "Missing product id");

      // Load Firestore record and validate ownership
      const ref = adminDb.collection("merchantProducts").doc(docId);
      const snap = await ref.get();
      if (!snap.exists) return bad(res, 404, "Product not found");
      const data = snap.data() || {};
      if (String(data.merchantId) !== uid) return bad(res, 403, "Not your product");

      const shopifyProductId: string | undefined = data.shopifyProductId;
      if (!shopifyProductId) return bad(res, 400, "Missing shopifyProductId on product");

      // Query Shopify for product details
      const g = await shopifyGraphQL(PRODUCT_DETAILS, { id: shopifyProductId });
      const gqlErr = g.errors?.[0]?.message;
      if (gqlErr) return bad(res, 502, `Shopify error: ${gqlErr}`);

      const p = g.data?.product;
      if (!p?.id) return bad(res, 404, "Product not found on Shopify");

      // Normalize variants
      const variants: any[] = (p.variants?.nodes || []).map((v: any) => {
        const selectedOptions = Array.isArray(v.selectedOptions) ? v.selectedOptions.map((o: any) => o?.value).filter(Boolean) : [];
        // price may be "price" (string/number) or "priceV2.amount"
        const priceNum =
          moneyToNumber(v.price) != null
            ? Number(v.price)
            : moneyToNumber(v.priceV2);

        const qtyAtLoc = readAvailableAtLocation(v?.inventoryItem?.inventoryLevels?.nodes || [], SHOPIFY_LOCATION_ID);

        return {
          id: v.id,
          title: v.title,
          optionValues: selectedOptions.length ? selectedOptions : undefined,
          price: priceNum,
          quantity: qtyAtLoc,
          sku: v.sku || undefined,
          barcode: v.barcode || undefined,
          weightGrams: v.weight != null ? Number(v.weight) : undefined,
          inventoryItemId: v?.inventoryItem?.id,
        };
      });

      return res.status(200).json({
        ok: true,
        product: {
          id: data.id,
          title: p.title || data.title,
          description: p.descriptionHtml ?? data.description ?? "",
          productOptions: (p.options || []).map((o: any) => ({
            name: o?.name || "",
            values: Array.isArray(o?.values) ? o.values : [],
          })),
          variants,
        },
      });
    }

    if (req.method === "POST") {
      /**
       * Body:
       * {
       *   id: string,   // merchantProducts doc id
       *   quick?: { price?: number, quantity?: number, variants?: [{id, price?, quantity?}, ...] },
       *   changes?: { title?, description?, productType?, vendor?, tags?, compareAtPrice?, barcode?, weightGrams?, removeVariantIds?: string[] },
       *   variantDraft?: { options: [{name, values[]}], variants: [{options[], title, price?, compareAtPrice?, sku?, quantity?, barcode?, weightGrams?}] }
       * }
       */
      const body = req.body || {};
      const docId = String(body.id || "");
      if (!docId) return bad(res, 400, "Missing product id");

      // Load product + validate ownership
      const ref = adminDb.collection("merchantProducts").doc(docId);
      const snap = await ref.get();
      if (!snap.exists) return bad(res, 404, "Product not found");
      const mp = snap.data() || {};
      if (String(mp.merchantId) !== uid) return bad(res, 403, "Not your product");

      const shopifyProductId: string | undefined = mp.shopifyProductId;
      if (!shopifyProductId) return bad(res, 400, "Missing shopifyProductId on product");

      const quick = body.quick || {};
      const changes = body.changes || {};
      const variantDraft = body.variantDraft || undefined;

      /* -------------------- QUICK UPDATES (live to Shopify) -------------------- */

      // 1) Price updates (product default or per-variant)
      const variantsForPrice: Array<{ id: string; price?: string }> = [];

      if (quick && typeof quick.price === "number") {
        // single-variant product default: use first variant GID from our doc
        const firstVariantGid = Array.isArray(mp.shopifyVariantIds) && mp.shopifyVariantIds[0];
        if (firstVariantGid) {
          variantsForPrice.push({ id: firstVariantGid, price: String(quick.price) });
        }
      }

      if (Array.isArray(quick?.variants)) {
        for (const v of quick.variants) {
          if (!v?.id) continue;
          if (typeof v.price === "number") {
            variantsForPrice.push({ id: v.id, price: String(v.price) });
          }
        }
      }

      if (variantsForPrice.length) {
        const upd = await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
          productId: shopifyProductId,
          variants: variantsForPrice,
        });
        const uerr = upd.data?.productVariantsBulkUpdate?.userErrors || [];
        if (uerr.length) {
          const msg = uerr.map((e: any) => e.message).join("; ");
          return bad(res, 502, `Price update failed: ${msg}`);
        }
      }

      // 2) Inventory updates (absolute set on-hand, requires location)
      // We need inventoryItemId for each variant we are changing quantity for.
      let inventorySetInput: Array<{ inventoryItemId: string; locationId: string; onHandQuantity: number }> = [];

      if (SHOPIFY_LOCATION_ID) {
        // For single-variant quick.quantity
        if (quick && typeof quick.quantity === "number") {
          // Fetch details to get the first variant's inventoryItemId
          const g = await shopifyGraphQL(PRODUCT_DETAILS, { id: shopifyProductId });
          const v0 = g?.data?.product?.variants?.nodes?.[0];
          const invItemId = v0?.inventoryItem?.id;
          if (invItemId) {
            inventorySetInput.push({
              inventoryItemId: invItemId,
              locationId: SHOPIFY_LOCATION_ID,
              onHandQuantity: Number(quick.quantity),
            });
          }
        }

        // Per-variant quantities
        if (Array.isArray(quick?.variants)) {
          // Fetch details once, map invItemId by variant id
          const g = await shopifyGraphQL(PRODUCT_DETAILS, { id: shopifyProductId });
          const nodes: any[] = g?.data?.product?.variants?.nodes || [];
          const invByVariant: Record<string, string> = {};
          for (const v of nodes) {
            if (v?.id && v?.inventoryItem?.id) invByVariant[v.id] = v.inventoryItem.id;
          }
          for (const v of quick.variants) {
            if (!v?.id || typeof v.quantity !== "number") continue;
            const invId = invByVariant[v.id];
            if (!invId) continue;
            inventorySetInput.push({
              inventoryItemId: invId,
              locationId: SHOPIFY_LOCATION_ID,
              onHandQuantity: Number(v.quantity),
            });
          }
        }

        if (inventorySetInput.length) {
          const invRes = await shopifyGraphQL(INVENTORY_SET_ON_HAND, {
            input: inventorySetInput,
          });
          const invErrs = invRes?.data?.inventorySetOnHandQuantities?.userErrors || [];
          if (invErrs.length) {
            const msg = invErrs.map((e: any) => e.message).join("; ");
            // Don't hard-fail the whole update; log and continue to queue review
            console.warn("Inventory update errors:", msg);
          }
        }
      } else {
        if (
          typeof quick?.quantity === "number" ||
          (Array.isArray(quick?.variants) && quick.variants.some((v: any) => typeof v?.quantity === "number"))
        ) {
          console.warn("SHOPIFY_LOCATION_ID not set; inventory quick updates skipped.");
        }
      }

      // Mirror some surface fields in merchantProducts for convenience
      const updateMirror: Record<string, any> = { updatedAt: Date.now() };
      if (typeof quick?.price === "number") updateMirror.price = Number(quick.price);
      if (typeof quick?.quantity === "number") updateMirror.stock = Number(quick.quantity);
      await ref.set(updateMirror, { merge: true });

      /* ----------------- CHANGE REQUEST (queued for admin review) ---------------- */

      // We mark update_in_review even for quick-only edits (as per your instruction)
      const hasQuick =
        typeof quick?.price === "number" ||
        typeof quick?.quantity === "number" ||
        (Array.isArray(quick?.variants) &&
          quick.variants.some((v: any) => typeof v?.price === "number" || typeof v?.quantity === "number"));

      const hasChanges =
        changes && Object.keys(changes).length > 0;

      const hasDraft =
        variantDraft && Array.isArray(variantDraft?.options) && Array.isArray(variantDraft?.variants) &&
        (variantDraft.options.length > 0 || variantDraft.variants.length > 0);

      // Create a change request doc if there is anything to record (quick or queued)
      if (hasQuick || hasChanges || hasDraft) {
        const crRef = adminDb.collection("productChangeRequests").doc();
        await crRef.set({
          id: crRef.id,
          type: "update",
          productDocId: docId,
          shopifyProductId,
          merchantId: uid,
          createdAt: Date.now(),
          status: "pending",
          quick: hasQuick ? quick : undefined,
          changes: hasChanges ? changes : undefined,
          variantDraft: hasDraft ? variantDraft : undefined,
          note: hasQuick
            ? "Price/Stock were applied live on Shopify. Remaining changes require admin review."
            : "Seller submitted changes for admin review.",
        });

        // Mark product as update_in_review for seller visibility
        await ref.set({ status: "update_in_review", updatedAt: Date.now() }, { merge: true });
      }

      return res.status(200).json({ ok: true });
    }

    return bad(res, 405, "Method not allowed");
  } catch (e: any) {
    console.error("seller products update error:", e?.message || e);
    return bad(res, 500, e?.message || "Internal error");
  }
}
