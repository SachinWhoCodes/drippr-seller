// api/admin/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import ImageKit from "imagekit";
import { shopifyGraphQL } from "../../_lib/shopify.js";

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
});

// ---- Shopify bits (Admin API) ----

// For the edit drawer “details” view
const PRODUCT_DETAILS_QUERY = /* GraphQL */ `
  query product($id: ID!) {
    product(id: $id) {
      id
      title
      options {
        name
        values
      }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          barcode
          inventoryQuantity
          weight
          weightUnit
          selectedOptions {
            name
            value
          }
        }
      }
    }
  }
`;

// Update variant price etc (NOT quantity)
const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Optional: absolute stock update if you configure a location
const INVENTORY_SET_ON_HAND = /* GraphQL */ `
  mutation inventorySetOnHandQuantities(
    $input: InventorySetOnHandQuantitiesInput!
  ) {
    inventorySetOnHandQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export default async function handler(req: any, res: any) {
  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    if (!token)
      return res
        .status(401)
        .json({ ok: false, error: "Missing Authorization" });

    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid as string;

    // ============= GET =============
    // (Simple product fetch; kept for backwards compatibility)
    if (req.method === "GET") {
      const id = String(req.query.id || "");
      if (!id)
        return res.status(400).json({ ok: false, error: "Missing id" });

      const snap = await adminDb
        .collection("merchantProducts")
        .doc(id)
        .get();
      if (!snap.exists)
        return res
          .status(404)
          .json({ ok: false, error: "Not found" });

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) {
        return res
          .status(403)
          .json({ ok: false, error: "Forbidden" });
      }

      return res.status(200).json({
        ok: true,
        product: { id: snap.id, ...doc },
      });
    }

    // ============= POST =============
    if (req.method === "POST") {
      const body = req.body || {};
      const op = typeof body.op === "string" ? body.op : "";

      /* ---------------- MEDIA OPS (for MediaBucket) ---------------- */
      // client: POST { op: "mediaSign" }
      if (op === "mediaSign") {
        if (
          !process.env.IMAGEKIT_PUBLIC_KEY ||
          !process.env.IMAGEKIT_URL_ENDPOINT ||
          !process.env.IMAGEKIT_PRIVATE_KEY
        ) {
          return res.status(500).json({
            ok: false,
            error: "ImageKit not configured on server",
          });
        }

        const authParams = imagekit.getAuthenticationParameters();
        return res.status(200).json({
          ok: true,
          auth: authParams, // { token, expire, signature }
          publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
          urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
        });
      }

      // client: POST { op: "mediaSave", records: [ { fileId, url, name, ... } ] }
      if (op === "mediaSave") {
        const records = Array.isArray(body.records)
          ? body.records
          : [];
        if (!records.length) {
          return res.status(400).json({
            ok: false,
            error: "No records to save",
          });
        }

        const batch = adminDb.batch();
        const now = Date.now();

        for (const rec of records) {
          const ref = adminDb.collection("merchantMedia").doc();
          batch.set(ref, {
            id: ref.id,
            merchantId: uid,
            fileId: rec.fileId || rec.file_id || null,
            name: rec.name || null,
            url: rec.url,
            thumbnailUrl:
              rec.thumbnailUrl ||
              rec.thumbnail_url ||
              rec.url,
            width: rec.width ?? null,
            height: rec.height ?? null,
            size: rec.size ?? null,
            format: rec.format ?? null,
            createdAt: now,
          });
        }

        await batch.commit();
        return res.status(200).json({
          ok: true,
          saved: records.length,
        });
      }

      /* ---------------- DETAILS for edit drawer ---------------- */
      // client: POST { op: "details", id: "<merchantProducts doc id>" }
      if (op === "details") {
        const id = String(body.id || "");
        if (!id)
          return res
            .status(400)
            .json({ ok: false, error: "Missing id" });

        const ref = adminDb
          .collection("merchantProducts")
          .doc(id);
        const snap = await ref.get();
        if (!snap.exists)
          return res
            .status(404)
            .json({ ok: false, error: "Not found" });

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) {
          return res
            .status(403)
            .json({ ok: false, error: "Forbidden" });
        }

        let productOptions: any[] = [];
        let variants: any[] = [];

        if (doc.shopifyProductId) {
          const r = await shopifyGraphQL(
            PRODUCT_DETAILS_QUERY,
            { id: doc.shopifyProductId }
          );
          const p = r?.data?.product;

          if (p) {
            productOptions = (p.options || []).map((o: any) => ({
              name: o.name || "",
              values: Array.isArray(o.values)
                ? o.values.filter(
                    (v: any) => typeof v === "string"
                  )
                : [],
            }));

            variants = (p.variants?.nodes || []).map(
              (v: any) => {
                const opts = Array.isArray(
                  v.selectedOptions
                )
                  ? v.selectedOptions.map((so: any) =>
                      String(so.value)
                    )
                  : [];
                let weightGrams: number | undefined;
                if (typeof v.weight === "number") {
                  if (v.weightUnit === "KILOGRAMS")
                    weightGrams = v.weight * 1000;
                  else if (v.weightUnit === "GRAMS")
                    weightGrams = v.weight;
                }

                return {
                  id: v.id,
                  title: v.title,
                  optionValues: opts,
                  price:
                    v.price != null
                      ? Number(v.price)
                      : undefined,
                  quantity:
                    typeof v.inventoryQuantity ===
                    "number"
                      ? v.inventoryQuantity
                      : undefined,
                  sku: v.sku || undefined,
                  barcode: v.barcode || undefined,
                  weightGrams,
                };
              }
            );
          }
        }

        return res.status(200).json({
          ok: true,
          product: {
            id: snap.id,
            ...doc,
            productOptions,
            variants,
          },
        });
      }

      /* ---------------- DEFAULT: product update ---------------- */
      // client (from Products.tsx edit):
      // POST {
      //   id,
      //   quick?: { price?, quantity?, variants?: [{ id, price?, quantity? }] },
      //   changes?: { title?, description?, productType?, tags?, vendor?, compareAtPrice?, barcode?, weightGrams?, removeVariantIds? },
      //   variantDraft?: { options, variants }
      // }
      const { id } = body;
      if (!id)
        return res
          .status(400)
          .json({ ok: false, error: "Missing id" });

      const ref = adminDb
        .collection("merchantProducts")
        .doc(id);
      const snap = await ref.get();
      if (!snap.exists)
        return res
          .status(404)
          .json({ ok: false, error: "Not found" });

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) {
        return res
          .status(403)
          .json({ ok: false, error: "Forbidden" });
      }

      const shopifyProductId: string | undefined =
        doc.shopifyProductId;
      const defaultVariantId: string | undefined = Array.isArray(
        doc.shopifyVariantIds
      )
        ? doc.shopifyVariantIds[0]
        : undefined;

      const updates: any = { updatedAt: Date.now() };
      let adminNeedsReview = false;

      // ----- 1) “quick” live changes (price / stock) -----
      const quick =
        body.quick && typeof body.quick === "object"
          ? body.quick
          : {};

      // Backwards-compat top-level fields:
      if (
        body.price != null &&
        body.price !== "" &&
        quick.price == null
      ) {
        quick.price = body.price;
      }
      if (
        body.stockQty != null &&
        body.stockQty !== "" &&
        quick.quantity == null
      ) {
        quick.quantity = body.stockQty;
      }

      const quickPrice =
        quick.price !== undefined ? Number(quick.price) : undefined;
      const quickQty =
        quick.quantity !== undefined
          ? Number(quick.quantity)
          : undefined;
      const quickVariants = Array.isArray(quick.variants)
        ? quick.variants
        : [];

      // Build payload for productVariantsBulkUpdate (price only)
      const variantsPayload: any[] = [];
      if (shopifyProductId) {
        if (
          defaultVariantId &&
          quickPrice != null &&
          !Number.isNaN(quickPrice)
        ) {
          variantsPayload.push({
            id: defaultVariantId,
            price: String(quickPrice),
          });
        }

        for (const v of quickVariants) {
          if (!v || !v.id) continue;
          if (v.price == null || v.price === "") continue;
          const vp = Number(v.price);
          if (Number.isNaN(vp)) continue;
          variantsPayload.push({
            id: v.id,
            price: String(vp),
          });
        }
      }

      // Push live price updates
      if (variantsPayload.length && shopifyProductId) {
        const updateRes = await shopifyGraphQL(
          VARIANTS_BULK_UPDATE,
          {
            productId: shopifyProductId,
            variants: variantsPayload,
          }
        );
        const errors =
          updateRes?.data?.productVariantsBulkUpdate
            ?.userErrors || [];
        if (errors.length) {
          const msg = errors
            .map((e: any) => e.message)
            .join("; ");
          return res.status(400).json({
            ok: false,
            error:
              msg || "Failed to update variants on Shopify",
          });
        }
      }

      // Reflect quick changes locally
      if (quickPrice != null && !Number.isNaN(quickPrice)) {
        updates.price = quickPrice;
      }

      if (quickQty != null && !Number.isNaN(quickQty)) {
        updates.stock = quickQty;

        const locationId = process.env.SHOPIFY_LOCATION_ID;
        const inventoryItemId: string | undefined =
          doc.inventoryItemId; // set this in create flow if you want stock->Shopify

        if (locationId && inventoryItemId) {
          try {
            const invRes = await shopifyGraphQL(
              INVENTORY_SET_ON_HAND,
              {
                input: {
                  reason: "correction",
                  setQuantities: [
                    {
                      inventoryItemId,
                      locationId,
                      quantity: quickQty,
                    },
                  ],
                },
              }
            );
            const invErrors =
              invRes?.data?.inventorySetOnHandQuantities
                ?.userErrors || [];
            if (invErrors.length) {
              console.warn(
                "inventorySetOnHandQuantities errors:",
                invErrors
              );
            }
          } catch (e) {
            console.warn(
              "inventorySetOnHandQuantities failed:",
              e
            );
          }
        }
      }

      // NOTE: variant-level quantity from quick.variants is *not*
      // pushed to Shopify here (needs per-variant inventoryItemId).
      // You could include it in pendingUpdates if you want admin to
      // handle it manually later.

      // ----- 2) “changes” for admin review -----
      const changes =
        body.changes && typeof body.changes === "object"
          ? body.changes
          : {};

      const changedForReview: Record<string, any> = {};

      const reviewFields = [
        "title",
        "description",
        "productType",
        "tags",
        "vendor",
        "compareAtPrice",
        "barcode",
        "weightGrams",
        "removeVariantIds",
      ] as const;

      for (const f of reviewFields) {
        if (changes[f] !== undefined) {
          changedForReview[f] = changes[f];
        }
      }

      const variantDraft =
        body.variantDraft !== undefined
          ? body.variantDraft
          : changes.variantDraft;

      if (variantDraft !== undefined) {
        changedForReview.variantDraft = variantDraft;
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

      const live =
        quickPrice != null ||
        quickQty != null ||
        (quickVariants && quickVariants.length > 0);

      return res.status(200).json({
        ok: true,
        review: adminNeedsReview,
        note: adminNeedsReview
          ? `Price/stock updated live where possible.${
              live ? " Other changes queued for admin review." : ""
            }`
          : live
          ? "Updated live on Shopify."
          : "No changes detected.",
      });
    }

    // Unsupported method
    return res
      .status(405)
      .json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    console.error("update endpoint error:", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Internal error",
    });
  }
}
