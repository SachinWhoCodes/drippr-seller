// api/admin/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import ImageKit from "imagekit";
import { shopifyGraphQL } from "../../_lib/shopify.js";

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
});

/* ---------------- Shopify GQL ---------------- */

// product details (variants) + images list for edit drawer
const PRODUCT_DETAILS_QUERY = /* GraphQL */ `
  query product($id: ID!) {
    product(id: $id) {
      id
      title
      options { name values }
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
          selectedOptions { name value }
        }
      }
      images(first: 100) {
        nodes { id url }
      }
    }
  }
`;

// live edits (price)
const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

// absolute stock (optional, if location is configured)
const INVENTORY_SET_ON_HAND = /* GraphQL */ `
  mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

// stage uploads (same shape as /api/admin/uploads/start)
const STAGED_UPLOADS_CREATE = /* GraphQL */ `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

// attach staged images to an existing product
const PRODUCT_CREATE_MEDIA = /* GraphQL */ `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id status }
      mediaUserErrors { field message }
    }
  }
`;

// list images (CDN urls)
const PRODUCT_IMAGES_QUERY = /* GraphQL */ `
  query productImages($id: ID!) {
    product(id: $id) {
      id
      images(first: 100) {
        nodes { id url }
      }
    }
  }
`;

// delete an image by image id
const PRODUCT_IMAGE_DELETE = /* GraphQL */ `
  mutation productImageDelete($id: ID!) {
    productImageDelete(id: $id) {
      deletedImageId
      userErrors { field message }
    }
  }
`;

/* ---------------- Helpers ---------------- */

async function listImageUrls(productId: string): Promise<{ idsByUrl: Record<string, string>, urls: string[] }> {
  const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
  const nodes = r?.data?.product?.images?.nodes || [];
  const urls: string[] = [];
  const idsByUrl: Record<string, string> = {};
  for (const n of nodes) {
    if (n?.url && n?.id) {
      urls.push(String(n.url));
      idsByUrl[String(n.url)] = String(n.id);
    }
  }
  return { idsByUrl, urls };
}

function gramsFrom(weight: number | null, unit: string | null) {
  if (typeof weight !== "number") return undefined;
  if (unit === "KILOGRAMS") return weight * 1000;
  if (unit === "GRAMS") return weight;
  return undefined;
}

function toNum(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/* ---------------- Handler ---------------- */

export default async function handler(req: any, res: any) {
  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });

    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid as string;

    /* ============= GET (simple fetch; supports ?live=1) ============= */
    if (req.method === "GET") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

      const snap = await adminDb.collection("merchantProducts").doc(id).get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      // Optional: return live variants/images if live=1
      if (String(req.query.live || "") === "1" && doc.shopifyProductId) {
        try {
          const r = await shopifyGraphQL(PRODUCT_DETAILS_QUERY, { id: doc.shopifyProductId });
          const p = r?.data?.product;
          const productOptions = (p?.options || []).map((o: any) => ({
            name: o.name || "",
            values: Array.isArray(o.values) ? o.values.filter((v: any) => typeof v === "string") : [],
          }));
          const variants = (p?.variants?.nodes || []).map((v: any) => ({
            id: v.id,
            title: v.title,
            optionValues: Array.isArray(v.selectedOptions) ? v.selectedOptions.map((so: any) => String(so.value)) : [],
            price: toNum(v.price),
            quantity: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : undefined,
            sku: v.sku || undefined,
            barcode: v.barcode || undefined,
            weightGrams: gramsFrom(v.weight, v.weightUnit),
          }));
          const imagesLive = (p?.images?.nodes || []).map((n: any) => String(n.url)).filter(Boolean);
          return res.status(200).json({ ok: true, product: { id: snap.id, ...doc, productOptions, variants, imagesLive } });
        } catch (e: any) {
          // Fall back to Firestore-only if Shopify read fails
          return res.status(200).json({ ok: true, product: { id: snap.id, ...doc } });
        }
      }

      // Default: Firestore only
      return res.status(200).json({ ok: true, product: { id: snap.id, ...doc } });
    }

    /* ============= POST ============= */
    if (req.method === "POST") {
      const body = req.body || {};
      const op = typeof body.op === "string" ? body.op : "";

      /* ---------- Media ops (ImageKit, unchanged) ---------- */
      if (op === "mediaSign") {
        if (!process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_URL_ENDPOINT || !process.env.IMAGEKIT_PRIVATE_KEY) {
          return res.status(500).json({ ok: false, error: "ImageKit not configured on server" });
        }
        const authParams = imagekit.getAuthenticationParameters();
        return res.status(200).json({
          ok: true,
          auth: authParams,
          publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
          urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
        });
      }

      if (op === "mediaSave") {
        const records = Array.isArray(body.records) ? body.records : [];
        if (!records.length) return res.status(400).json({ ok: false, error: "No records to save" });

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
            thumbnailUrl: rec.thumbnailUrl || rec.thumbnail_url || rec.url,
            width: rec.width ?? null,
            height: rec.height ?? null,
            size: rec.size ?? null,
            format: rec.format ?? null,
            createdAt: now,
          });
        }
        await batch.commit();
        return res.status(200).json({ ok: true, saved: records.length });
      }

      /* ---------- New: image edit pipeline ---------- */

      // 1) Return staged targets for given files (like /uploads/start)
      if (op === "imagesStage") {
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return res.status(400).json({ ok: false, error: "No files provided" });

        const input = files.map((f: any) => ({
          resource: "IMAGE",
          filename: String(f.filename || "image.jpg"),
          mimeType: String(f.mimeType || "image/jpeg"),
          fileSize: String(f.fileSize), // Shopify wants UnsignedInt64 as string
          httpMethod: "POST",
        }));

        try {
          const r = await shopifyGraphQL(STAGED_UPLOADS_CREATE, { input });
          const userErrors = r?.data?.stagedUploadsCreate?.userErrors || [];
          if (userErrors.length) {
            return res.status(400).json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
          }
          const targets = r?.data?.stagedUploadsCreate?.stagedTargets || [];
          return res.status(200).json({ ok: true, targets });
        } catch (e: any) {
          return res.status(400).json({ ok: false, error: e?.message || "stagedUploadsCreate failed" });
        }
      }

      // 2) Attach staged images to Shopify product and mirror CDN urls in Firestore
      if (op === "imagesAttach") {
        const mpDocId = String(body.id || "");
        const resourceUrls: string[] = Array.isArray(body.resourceUrls) ? body.resourceUrls : [];
        if (!mpDocId) return res.status(400).json({ ok: false, error: "Missing id" });
        if (!resourceUrls.length) return res.status(400).json({ ok: false, error: "No resourceUrls" });

        const ref = adminDb.collection("merchantProducts").doc(mpDocId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return res.status(403).json({ ok: false, error: "Forbidden" });

        const shopifyProductId: string | undefined = doc.shopifyProductId;
        if (!shopifyProductId) return res.status(400).json({ ok: false, error: "No Shopify product id" });

        try {
          const media = resourceUrls.map(u => ({ originalSource: u, mediaContentType: "IMAGE" as const }));
          const attachRes = await shopifyGraphQL(PRODUCT_CREATE_MEDIA, { productId: shopifyProductId, media });
          const mErrors = attachRes?.data?.productCreateMedia?.mediaUserErrors || [];
          if (mErrors.length) {
            return res.status(400).json({ ok: false, error: mErrors.map((e: any) => e.message).join("; ") });
          }
          // fetch fresh CDN urls
          const { urls } = await listImageUrls(shopifyProductId);
          const now = Date.now();
          await ref.set({ images: urls, image: urls[0] || null, updatedAt: now }, { merge: true });
          return res.status(200).json({ ok: true, images: urls });
        } catch (e: any) {
          return res.status(400).json({ ok: false, error: e?.message || "productCreateMedia failed" });
        }
      }

      // 3) Delete selected images by URL
      if (op === "imagesDelete") {
        const mpDocId = String(body.id || "");
        const urlsToDelete: string[] = Array.isArray(body.urls) ? body.urls : [];
        if (!mpDocId) return res.status(400).json({ ok: false, error: "Missing id" });
        if (!urlsToDelete.length) return res.status(400).json({ ok: false, error: "No urls" });

        const ref = adminDb.collection("merchantProducts").doc(mpDocId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return res.status(403).json({ ok: false, error: "Forbidden" });

        const shopifyProductId: string | undefined = doc.shopifyProductId;
        if (!shopifyProductId) return res.status(400).json({ ok: false, error: "No Shopify product id" });

        try {
          const { idsByUrl } = await listImageUrls(shopifyProductId);
          for (const u of urlsToDelete) {
            const imgId = idsByUrl[u];
            if (!imgId) continue;
            const del = await shopifyGraphQL(PRODUCT_IMAGE_DELETE, { id: imgId });
            const errs = del?.data?.productImageDelete?.userErrors || [];
            if (errs.length) {
              return res.status(400).json({ ok: false, error: errs.map((e: any) => e.message).join("; ") });
            }
          }
          const refreshed = await listImageUrls(shopifyProductId);
          const now = Date.now();
          await ref.set({ images: refreshed.urls, image: refreshed.urls[0] || null, updatedAt: now }, { merge: true });
          return res.status(200).json({ ok: true, images: refreshed.urls });
        } catch (e: any) {
          return res.status(400).json({ ok: false, error: e?.message || "productImageDelete failed" });
        }
      }

      /* ---------- Details for edit drawer (POST variant) ---------- */
      if (op === "details") {
        const id = String(body.id || "");
        if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

        const ref = adminDb.collection("merchantProducts").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) {
          return res.status(403).json({ ok: false, error: "Forbidden" });
        }

        let productOptions: any[] = [];
        let variants: any[] = [];
        let imagesLive: string[] = [];

        if (doc.shopifyProductId) {
          try {
            const r = await shopifyGraphQL(PRODUCT_DETAILS_QUERY, { id: doc.shopifyProductId });
            const p = r?.data?.product;

            if (p) {
              productOptions = (p.options || []).map((o: any) => ({
                name: o.name || "",
                values: Array.isArray(o.values) ? o.values.filter((v: any) => typeof v === "string") : [],
              }));

              variants = (p.variants?.nodes || []).map((v: any) => {
                const opts = Array.isArray(v.selectedOptions) ? v.selectedOptions.map((so: any) => String(so.value)) : [];
                return {
                  id: v.id,
                  title: v.title,
                  optionValues: opts,
                  price: toNum(v.price),
                  quantity: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : undefined,
                  sku: v.sku || undefined,
                  barcode: v.barcode || undefined,
                  weightGrams: gramsFrom(v.weight, v.weightUnit),
                };
              });

              imagesLive = (p.images?.nodes || []).map((n: any) => String(n.url)).filter(Boolean);
            }
          } catch (e) {
            // swallow; return Firestore-only
          }
        }

        return res.status(200).json({
          ok: true,
          product: { id: snap.id, ...doc, productOptions, variants, imagesLive },
        });
      }

      /* ---------- Default: product update (live + review) ---------- */
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

      const ref = adminDb.collection("merchantProducts").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const shopifyProductId: string | undefined = doc.shopifyProductId;
      const defaultVariantId: string | undefined =
        Array.isArray(doc.shopifyVariantIds) ? doc.shopifyVariantIds[0] : undefined;

      const updates: any = { updatedAt: Date.now() };
      let adminNeedsReview = false;

      // ----- quick (price / stock) -----
      const quick = body.quick && typeof body.quick === "object" ? body.quick : {};

      if (body.price != null && body.price !== "" && quick.price == null) quick.price = body.price;
      if (body.stockQty != null && body.stockQty !== "" && quick.quantity == null) quick.quantity = body.stockQty;

      const quickPrice = quick.price !== undefined ? Number(quick.price) : undefined;
      const quickQty = quick.quantity !== undefined ? Number(quick.quantity) : undefined;
      const quickVariants = Array.isArray(quick.variants) ? quick.variants : [];

      // Build payload for productVariantsBulkUpdate (guarded)
      const variantsPayload: any[] = [];
      if (shopifyProductId) {
        if (defaultVariantId && quickPrice != null && !Number.isNaN(quickPrice)) {
          variantsPayload.push({ id: defaultVariantId, price: String(quickPrice) });
        }
        for (const v of quickVariants) {
          if (!v || !v.id) continue;
          if (v.price == null || v.price === "") continue;
          const vp = Number(v.price);
          if (Number.isNaN(vp)) continue;
          variantsPayload.push({ id: v.id, price: String(vp) });
        }
      }

      if (variantsPayload.length && shopifyProductId) {
        try {
          const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, { productId: shopifyProductId, variants: variantsPayload });
          const errors = updateRes?.data?.productVariantsBulkUpdate?.userErrors || [];
          if (errors.length) {
            const msg = errors.map((e: any) => e.message).join("; ");
            return res.status(400).json({ ok: false, error: msg || "Failed to update variants on Shopify" });
          }
        } catch (e: any) {
          return res.status(400).json({ ok: false, error: e?.message || "Failed to update variants on Shopify" });
        }
      }

      // Reflect quick changes locally
      if (quickPrice != null && !Number.isNaN(quickPrice)) updates.price = quickPrice;

      if (quickQty != null && !Number.isNaN(quickQty)) {
        updates.stock = quickQty;

        const locationId = process.env.SHOPIFY_LOCATION_ID;
        const inventoryItemId: string | undefined = doc.inventoryItemId;
        if (locationId && inventoryItemId) {
          try {
            const invRes = await shopifyGraphQL(INVENTORY_SET_ON_HAND, {
              input: {
                reason: "correction",
                setQuantities: [{ inventoryItemId, locationId, quantity: quickQty }],
              }
            });
            const invErrors = invRes?.data?.inventorySetOnHandQuantities?.userErrors || [];
            if (invErrors.length) console.warn("inventorySetOnHandQuantities errors:", invErrors);
          } catch (e) {
            console.warn("inventorySetOnHandQuantities failed:", e);
          }
        }
      }

      // ----- review changes -----
      const changes = body.changes && typeof body.changes === "object" ? body.changes : {};
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

      for (const f of reviewFields) if (changes[f] !== undefined) changedForReview[f] = changes[f];
      const variantDraft = body.variantDraft !== undefined ? body.variantDraft : changes.variantDraft;
      if (variantDraft !== undefined) changedForReview.variantDraft = variantDraft;

      if (Object.keys(changedForReview).length) {
        adminNeedsReview = true;
        updates.pendingUpdates = { ...(doc.pendingUpdates || {}), ...changedForReview };
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
          ? `Price/stock updated live where possible.${live ? " Other changes queued for admin review." : ""}`
          : live
          ? "Updated live on Shopify."
          : "No changes detected.",
      });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    console.error("update endpoint error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
