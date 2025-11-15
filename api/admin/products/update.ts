// api/admin/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import ImageKit from "imagekit";
import { shopifyGraphQL } from "../../_lib/shopify.js";

/* ---------------- ImageKit (kept for Media Bucket) ---------------- */
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
});

/* ---------------- Shopify: product details + media ---------------- */
const PRODUCT_DETAILS_QUERY = /* GraphQL */ `
  query product($id: ID!) {
    product(id: $id) {
      id
      title
      options { name values }
      variants(first: 100) {
        nodes {
          id title sku price compareAtPrice barcode
          inventoryQuantity
          weight weightUnit
          selectedOptions { name value }
        }
      }
      media(first: 100) {
        nodes {
          ... on MediaImage {
            id
            image { url }
            preview { image { url } }
          }
        }
      }
    }
  }
`;

/* ---------------- Shopify: staged uploads + media CRUD ------------ */
const STAGED_UPLOADS_CREATE = /* GraphQL */ `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA = /* GraphQL */ `
  mutation productCreateMedia(
    $productId: ID!
    $media: [CreateMediaInput!]!
    $mediaContentType: MediaContentType!
  ) {
    productCreateMedia(
      productId: $productId,
      media: $media,
      mediaContentType: IMAGE
    ) {
      media {
        ... on MediaImage { id image { url } preview { image { url } } }
      }
      mediaUserErrors { field message }
    }
  }
`;

const PRODUCT_DELETE_MEDIA = /* GraphQL */ `
  mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message }
    }
  }
`;

/* ---------------- Shopify: price/stock ---------------------------------- */
const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

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
    const uid = decoded.uid as string;

    /* ========================= GET ========================= */
    if (req.method === "GET") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

      const snap = await adminDb.collection("merchantProducts").doc(id).get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      return res.status(200).json({ ok: true, product: { id: snap.id, ...doc } });
    }

    /* ========================= POST ========================= */
    if (req.method === "POST") {
      const body = req.body || {};
      const op = typeof body.op === "string" ? body.op : "";

      /* -------- MediaBucket (ImageKit) signatures/save -------- */
      if (op === "mediaSign") {
        if (!process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_URL_ENDPOINT || !process.env.IMAGEKIT_PRIVATE_KEY) {
          return res.status(500).json({ ok: false, error: "ImageKit not configured on server" });
        }
        const authParams = imagekit.getAuthenticationParameters();
        return res.status(200).json({
          ok: true,
          auth: authParams,
          publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
          urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
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

      /* ---------------------- DETAILS (for edit) ---------------------- */
      if (op === "details") {
        const id = String(body.id || "");
        if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

        const ref = adminDb.collection("merchantProducts").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return res.status(403).json({ ok: false, error: "Forbidden" });

        let productOptions: any[] = [];
        let variants: any[] = [];
        let imagesLive: string[] = [];

        if (doc.shopifyProductId) {
          const r = await shopifyGraphQL(PRODUCT_DETAILS_QUERY, { id: doc.shopifyProductId });
          const p = r?.data?.product;

          if (p) {
            productOptions = (p.options || []).map((o: any) => ({
              name: o.name || "",
              values: Array.isArray(o.values) ? o.values.filter((v: any) => typeof v === "string") : [],
            }));

            variants = (p.variants?.nodes || []).map((v: any) => {
              const opts = Array.isArray(v.selectedOptions) ? v.selectedOptions.map((so: any) => String(so.value)) : [];
              let weightGrams: number | undefined;
              if (typeof v.weight === "number") {
                if (v.weightUnit === "KILOGRAMS") weightGrams = v.weight * 1000;
                else if (v.weightUnit === "GRAMS") weightGrams = v.weight;
              }
              return {
                id: v.id,
                title: v.title,
                optionValues: opts,
                price: v.price != null ? Number(v.price) : undefined,
                quantity: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : undefined,
                sku: v.sku || undefined,
                barcode: v.barcode || undefined,
                weightGrams,
              };
            });

            imagesLive =
              (p.media?.nodes || [])
                .map((n: any) => n?.image?.url || n?.preview?.image?.url)
                .filter((u: any) => typeof u === "string") || [];
          }
        }

        return res.status(200).json({
          ok: true,
          product: { id: snap.id, ...doc, productOptions, variants, imagesLive },
        });
      }

      /* ---------------------- IMAGE EDIT OPS ---------------------- */

      // a) Get Shopify staged upload targets (so the client can POST file to S3)
      // client -> POST { op: "imagesStage", files: [{ filename, mimeType, fileSize }] }
      if (op === "imagesStage") {
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return res.status(400).json({ ok: false, error: "No files provided" });

        const input = files.map((f: any) => ({
          resource: "IMAGE",
          filename: String(f.filename || "image.jpg"),
          mimeType: String(f.mimeType || "image/jpeg"),
          fileSize: String(f.fileSize ?? 0), // UnsignedInt64 must be string
          httpMethod: "POST",
        }));

        const r = await shopifyGraphQL(STAGED_UPLOADS_CREATE, { input });
        const targets = r?.data?.stagedUploadsCreate?.stagedTargets || [];
        const err = r?.data?.stagedUploadsCreate?.userErrors || [];
        if (err.length) return res.status(400).json({ ok: false, error: err.map((e: any) => e.message).join("; ") });

        return res.status(200).json({ ok: true, targets });
      }

      // b) Attach staged images to existing Shopify product, refresh Firestore images
      // client -> POST { op: "imagesAttach", id: "<merchantProducts doc id>", resourceUrls: [ ... ] }
      if (op === "imagesAttach") {
        const id = String(body.id || "");
        const urls: string[] = Array.isArray(body.resourceUrls) ? body.resourceUrls : [];
        if (!id || !urls.length) return res.status(400).json({ ok: false, error: "Missing id or resourceUrls" });

        const ref = adminDb.collection("merchantProducts").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });
        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return res.status(403).json({ ok: false, error: "Forbidden" });
        if (!doc.shopifyProductId) return res.status(400).json({ ok: false, error: "Shopify product missing" });

        const media = urls.slice(0, 20).map((u) => ({ originalSource: u }));
        const cr = await shopifyGraphQL(PRODUCT_CREATE_MEDIA, {
          productId: doc.shopifyProductId,
          media,
          mediaContentType: "IMAGE",
        });
        const mErr = cr?.data?.productCreateMedia?.mediaUserErrors || [];
        if (mErr.length) return res.status(400).json({ ok: false, error: mErr.map((e: any) => e.message).join("; ") });

        // read current media -> permanent URLs
        const dr = await shopifyGraphQL(PRODUCT_DETAILS_QUERY, { id: doc.shopifyProductId });
        const live: string[] =
          (dr?.data?.product?.media?.nodes || [])
            .map((n: any) => n?.image?.url || n?.preview?.image?.url)
            .filter((u: any) => typeof u === "string");

        await ref.set(
          { images: live, image: live[0] || null, imageUrls: live, updatedAt: Date.now() },
          { merge: true }
        );

        return res.status(200).json({ ok: true, images: live });
      }

      // c) Delete images by URL from Shopify product, refresh Firestore images
      // client -> POST { op: "imagesDelete", id: "<merchantProducts doc id>", urls: [ ... ] }
      if (op === "imagesDelete") {
        const id = String(body.id || "");
        const urls: string[] = Array.isArray(body.urls) ? body.urls : [];
        if (!id || !urls.length) return res.status(400).json({ ok: false, error: "Missing id or urls" });

        const ref = adminDb.collection("merchantProducts").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });
        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return res.status(403).json({ ok: false, error: "Forbidden" });
        if (!doc.shopifyProductId) return res.status(400).json({ ok: false, error: "Shopify product missing" });

        // map URLs -> mediaIds
        const r = await shopifyGraphQL(PRODUCT_DETAILS_QUERY, { id: doc.shopifyProductId });
        const nodes = r?.data?.product?.media?.nodes || [];
        const byUrl: Record<string, string> = {};
        for (const n of nodes) {
          const u = n?.image?.url || n?.preview?.image?.url;
          if (u && n?.id) byUrl[u] = n.id;
        }
        const mediaIds = urls.map((u) => byUrl[u]).filter(Boolean);
        if (!mediaIds.length) return res.status(400).json({ ok: false, error: "No matching media found for given URLs" });

        const del = await shopifyGraphQL(PRODUCT_DELETE_MEDIA, { productId: doc.shopifyProductId, mediaIds });
        const dErr = del?.data?.productDeleteMedia?.mediaUserErrors || [];
        if (dErr.length) return res.status(400).json({ ok: false, error: dErr.map((e: any) => e.message).join("; ") });

        // refresh URLs
        const fr = await shopifyGraphQL(PRODUCT_DETAILS_QUERY, { id: doc.shopifyProductId });
        const live: string[] =
          (fr?.data?.product?.media?.nodes || [])
            .map((n: any) => n?.image?.url || n?.preview?.image?.url)
            .filter((u: any) => typeof u === "string");

        await ref.set(
          { images: live, image: live[0] || null, imageUrls: live, updatedAt: Date.now() },
          { merge: true }
        );
        return res.status(200).json({ ok: true, images: live });
      }

      /* ---------------------- DEFAULT (existing update flow) ---------------------- */
      // (all your quick price/stock + review fields flow kept intact)
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

      const ref = adminDb.collection("merchantProducts").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) return res.status(403).json({ ok: false, error: "Forbidden" });

      const shopifyProductId: string | undefined = doc.shopifyProductId;
      const defaultVariantId: string | undefined = Array.isArray(doc.shopifyVariantIds) ? doc.shopifyVariantIds[0] : undefined;

      const updates: any = { updatedAt: Date.now() };
      let adminNeedsReview = false;

      const quick = body.quick && typeof body.quick === "object" ? body.quick : {};
      if (body.price != null && body.price !== "" && quick.price == null) quick.price = body.price;
      if (body.stockQty != null && body.stockQty !== "" && quick.quantity == null) quick.quantity = body.stockQty;

      const quickPrice = quick.price !== undefined ? Number(quick.price) : undefined;
      const quickQty = quick.quantity !== undefined ? Number(quick.quantity) : undefined;
      const quickVariants = Array.isArray(quick.variants) ? quick.variants : [];

      const variantsPayload: any[] = [];
      if (shopifyProductId) {
        if (defaultVariantId && quickPrice != null && !Number.isNaN(quickPrice)) {
          variantsPayload.push({ id: defaultVariantId, price: String(quickPrice) });
        }
        for (const v of quickVariants) {
          if (!v || !v.id) continue;
          if (v.price == null || v.price === "") continue;
          const vp = Number(v.price);
          if (!Number.isNaN(vp)) variantsPayload.push({ id: v.id, price: String(vp) });
        }
      }

      if (variantsPayload.length && shopifyProductId) {
        const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, { productId: shopifyProductId, variants: variantsPayload });
        const errors = updateRes?.data?.productVariantsBulkUpdate?.userErrors || [];
        if (errors.length) {
          const msg = errors.map((e: any) => e.message).join("; ");
          return res.status(400).json({ ok: false, error: msg || "Failed to update variants on Shopify" });
        }
      }

      if (quickPrice != null && !Number.isNaN(quickPrice)) updates.price = quickPrice;
      if (quickQty != null && !Number.isNaN(quickQty)) {
        updates.stock = quickQty;
        const locationId = process.env.SHOPIFY_LOCATION_ID;
        const inventoryItemId: string | undefined = doc.inventoryItemId;
        if (locationId && inventoryItemId) {
          try {
            const invRes = await shopifyGraphQL(INVENTORY_SET_ON_HAND, {
              input: { reason: "correction", setQuantities: [{ inventoryItemId, locationId, quantity: quickQty }] },
            });
            const invErrors = invRes?.data?.inventorySetOnHandQuantities?.userErrors || [];
            if (invErrors.length) console.warn("inventorySetOnHandQuantities errors:", invErrors);
          } catch (e) {
            console.warn("inventorySetOnHandQuantities failed:", e);
          }
        }
      }

      const changes = body.changes && typeof body.changes === "object" ? body.changes : {};
      const changedForReview: Record<string, any> = {};
      const reviewFields = ["title","description","productType","tags","vendor","compareAtPrice","barcode","weightGrams","removeVariantIds"] as const;
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
          : live ? "Updated live on Shopify." : "No changes detected.",
      });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    console.error("update endpoint error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
