// api/admin/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import ImageKit from "imagekit";
import { shopifyGraphQL } from "../../_lib/shopify.js";

const DEBUG = process.env.API_DEBUG === "1" || process.env.NODE_ENV !== "production";
const log = (...a: any[]) => { if (DEBUG) console.log("[products.update]", ...a); };

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
});

/* ---------------- Shopify GQL ---------------- */

// NOTE: removed weight and weightUnit from ProductVariant
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
          selectedOptions { name value }
        }
      }
      images(first: 100) { nodes { id url } }
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

const INVENTORY_SET_ON_HAND = /* GraphQL */ `
  mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

const STAGED_UPLOADS_CREATE = /* GraphQL */ `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA = /* GraphQL */ `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id status }
      mediaUserErrors { field message }
    }
  }
`;

const PRODUCT_IMAGES_QUERY = /* GraphQL */ `
  query productImages($id: ID!) {
    product(id: $id) {
      id
      images(first: 100) { nodes { id url } }
    }
  }
`;

const PRODUCT_IMAGE_DELETE = /* GraphQL */ `
  mutation productImageDelete($id: ID!) {
    productImageDelete(id: $id) {
      deletedImageId
      userErrors { field message }
    }
  }
`;

/* ---------------- Helpers ---------------- */

function gqlName(doc: string) {
  const m = /(query|mutation)\s+([A-Za-z0-9_]+)/.exec(doc);
  return m?.[2] || "unknown";
}

async function sgql(doc: string, vars: any, where: string) {
  const name = gqlName(doc);
  try {
    const r = await shopifyGraphQL(doc, vars);
    if (r?.errors?.length) {
      throw new Error(r.errors.map((e: any) => e?.message || "GraphQL error").join("; "));
    }
    return r;
  } catch (e: any) {
    const msg = `[${where}:${name}] ${e?.message || e}`;
    log(msg);
    throw new Error(msg);
  }
}

async function listImageUrls(productId: string): Promise<{ idsByUrl: Record<string, string>, urls: string[] }> {
  const r = await sgql(PRODUCT_IMAGES_QUERY, { id: productId }, "listImageUrls");
  const nodes = r?.data?.product?.images?.nodes || [];
  const urls: string[] = [];
  const idsByUrl: Record<string, string> = {};
  for (const n of nodes) {
    if (n?.url && n?.id) {
      const u = String(n.url);
      urls.push(u);
      idsByUrl[u] = String(n.id);
    }
  }
  return { idsByUrl, urls };
}

function bad(res: any, status: number, code: string, error?: any, extra?: any) {
  const payload: any = { ok: false, code, error: (error?.message ?? error ?? "Unknown error") };
  if (DEBUG && extra) payload.extra = extra;
  return res.status(status).json(payload);
}

/* ---------------- Handler ---------------- */

export default async function handler(req: any, res: any) {
  const started = Date.now();
  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return bad(res, 401, "auth/missing", "Missing Authorization");

    let uid = "";
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      uid = decoded.uid as string;
    } catch (e) {
      return bad(res, 401, "auth/verify-failed", e);
    }

    if (req.method === "GET") {
      const id = String(req.query.id || "");
      if (!id) return bad(res, 400, "get/missing-id");

      const snap = await adminDb.collection("merchantProducts").doc(id).get();
      if (!snap.exists) return bad(res, 404, "get/not-found");

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) return bad(res, 403, "get/forbidden");

      return res.status(200).json({ ok: true, product: { id: snap.id, ...doc } });
    }

    if (req.method !== "POST") return bad(res, 405, "method/not-allowed");

    const body = req.body || {};
    const op = typeof body.op === "string" ? body.op : "";

    log("op:", op);

    /* ---------- ImageKit sign/save ---------- */
    if (op === "mediaSign") {
      if (!process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_URL_ENDPOINT || !process.env.IMAGEKIT_PRIVATE_KEY) {
        return bad(res, 500, "images/sign/config-missing", "ImageKit not configured on server");
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
      try {
        const records = Array.isArray(body.records) ? body.records : [];
        if (!records.length) return bad(res, 400, "images/save/no-records");

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
      } catch (e) {
        return bad(res, 500, "images/save/exception", e);
      }
    }

    /* ---------- Image ops for edit drawer ---------- */
    if (op === "imagesStage") {
      try {
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return bad(res, 400, "images/stage/no-files");

        const input = files.map((f: any) => ({
          resource: "IMAGE",
          filename: String(f.filename || "image.jpg"),
          mimeType: String(f.mimeType || "image/jpeg"),
          fileSize: String(f.fileSize ?? f.size ?? 0),
          httpMethod: "POST",
        }));

        const r = await sgql(STAGED_UPLOADS_CREATE, { input }, "imagesStage");
        const errs = r?.data?.stagedUploadsCreate?.userErrors || [];
        if (errs.length) return bad(res, 400, "images/stage/userErrors", new Error(errs.map((e: any) => e.message).join("; ")), { errs });

        const targets = r?.data?.stagedUploadsCreate?.stagedTargets || [];
        return res.status(200).json({ ok: true, targets });
      } catch (e) {
        return bad(res, 500, "images/stage/exception", e);
      }
    }

    if (op === "imagesAttach") {
      try {
        const mpDocId = String(body.id || "");
        const resourceUrls: string[] = Array.isArray(body.resourceUrls) ? body.resourceUrls : [];
        if (!mpDocId) return bad(res, 400, "images/attach/missing-id");
        if (!resourceUrls.length) return bad(res, 400, "images/attach/no-resourceUrls");

        const ref = adminDb.collection("merchantProducts").doc(mpDocId);
        const snap = await ref.get();
        if (!snap.exists) return bad(res, 404, "images/attach/not-found");

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return bad(res, 403, "images/attach/forbidden");

        const shopifyProductId: string | undefined = doc.shopifyProductId;
        if (!shopifyProductId) return bad(res, 400, "images/attach/no-shopifyProductId");

        const media = resourceUrls.map(u => ({ originalSource: u, mediaContentType: "IMAGE" as const }));
        const attach = await sgql(PRODUCT_CREATE_MEDIA, { productId: shopifyProductId, media }, "imagesAttach");
        const mErrs = attach?.data?.productCreateMedia?.mediaUserErrors || [];
        if (mErrs.length) return bad(res, 400, "images/attach/mediaUserErrors", new Error(mErrs.map((e:any)=>e.message).join("; ")), { mErrs });

        const { urls } = await listImageUrls(shopifyProductId);
        await ref.set({ images: urls, image: urls[0] || null, updatedAt: Date.now() }, { merge: true });

        return res.status(200).json({ ok: true, images: urls });
      } catch (e) {
        return bad(res, 500, "images/attach/exception", e);
      }
    }

    if (op === "imagesDelete") {
      try {
        const mpDocId = String(body.id || "");
        const urlsToDelete: string[] = Array.isArray(body.urls) ? body.urls : [];
        if (!mpDocId) return bad(res, 400, "images/delete/missing-id");
        if (!urlsToDelete.length) return bad(res, 400, "images/delete/no-urls");

        const ref = adminDb.collection("merchantProducts").doc(mpDocId);
        const snap = await ref.get();
        if (!snap.exists) return bad(res, 404, "images/delete/not-found");

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return bad(res, 403, "images/delete/forbidden");

        const shopifyProductId: string | undefined = doc.shopifyProductId;
        if (!shopifyProductId) return bad(res, 400, "images/delete/no-shopifyProductId");

        const { idsByUrl } = await listImageUrls(shopifyProductId);

        for (const u of urlsToDelete) {
          const imgId = idsByUrl[u];
          if (!imgId) { log("imagesDelete: URL not found on Shopify", u); continue; }
          try {
            const del = await sgql(PRODUCT_IMAGE_DELETE, { id: imgId }, "imagesDelete");
            const errs = del?.data?.productImageDelete?.userErrors || [];
            if (errs.length) log("productImageDelete userErrors:", errs);
          } catch (e) {
            log("productImageDelete failed:", e);
          }
        }

        const refreshed = await listImageUrls(shopifyProductId);
        await ref.set({ images: refreshed.urls, image: refreshed.urls[0] || null, updatedAt: Date.now() }, { merge: true });

        return res.status(200).json({ ok: true, images: refreshed.urls });
      } catch (e) {
        return bad(res, 500, "images/delete/exception", e);
      }
    }

    /* ---------- Details for edit drawer ---------- */
    if (op === "details") {
      try {
        const id = String(body.id || "");
        if (!id) return bad(res, 400, "details/missing-id");

        const ref = adminDb.collection("merchantProducts").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return bad(res, 404, "details/not-found");

        const doc = snap.data() || {};
        if (doc.merchantId && doc.merchantId !== uid) return bad(res, 403, "details/forbidden");

        let productOptions: any[] = [];
        let variants: any[] = [];
        let imagesLive: string[] = [];

        if (doc.shopifyProductId) {
          const r = await sgql(PRODUCT_DETAILS_QUERY, { id: doc.shopifyProductId }, "details");
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
                price: v.price != null ? Number(v.price) : undefined,
                quantity: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : undefined,
                sku: v.sku || undefined,
                barcode: v.barcode || undefined,
                // weightGrams omitted (field removed in your API version)
              };
            });

            imagesLive = (p.images?.nodes || []).map((n: any) => String(n.url)).filter(Boolean);
          }
        }

        return res.status(200).json({
          ok: true,
          product: { id: snap.id, ...doc, productOptions, variants, imagesLive },
        });
      } catch (e) {
        return bad(res, 500, "details/exception", e);
      }
    }

    /* ---------- Default: product update (quick + review) ---------- */
    try {
      const { id } = body;
      if (!id) return bad(res, 400, "update/missing-id");

      const ref = adminDb.collection("merchantProducts").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return bad(res, 404, "update/not-found");

      const doc = snap.data() || {};
      if (doc.merchantId && doc.merchantId !== uid) return bad(res, 403, "update/forbidden");

      const shopifyProductId: string | undefined = doc.shopifyProductId;
      const defaultVariantId: string | undefined =
        Array.isArray(doc.shopifyVariantIds) ? doc.shopifyVariantIds[0] : (doc.shopifyVariantId || undefined);

      const updates: any = { updatedAt: Date.now() };
      let adminNeedsReview = false;

      // ----- quick (price / stock) -----
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
          if (Number.isNaN(vp)) continue;
          variantsPayload.push({ id: v.id, price: String(vp) });
        }
      }

      if (variantsPayload.length && shopifyProductId) {
        const updateRes = await sgql(VARIANTS_BULK_UPDATE, { productId: shopifyProductId, variants: variantsPayload }, "update/variants");
        const errors = updateRes?.data?.productVariantsBulkUpdate?.userErrors || [];
        if (errors.length) return bad(res, 400, "update/variants/userErrors", new Error(errors.map((e:any)=>e.message).join("; ")), { errors });
      }

      if (quickPrice != null && !Number.isNaN(quickPrice)) updates.price = quickPrice;

      if (quickQty != null && !Number.isNaN(quickQty)) {
        updates.stock = quickQty;

        const locationId = process.env.SHOPIFY_LOCATION_ID;
        const inventoryItemId: string | undefined = doc.inventoryItemId;
        if (locationId && inventoryItemId) {
          try {
            const invRes = await sgql(
              INVENTORY_SET_ON_HAND,
              { input: { reason: "correction", setQuantities: [{ inventoryItemId, locationId, quantity: quickQty }] } },
              "update/inventory"
            );
            const invErrors = invRes?.data?.inventorySetOnHandQuantities?.userErrors || [];
            if (invErrors.length) log("inventorySetOnHandQuantities userErrors:", invErrors);
          } catch (e) {
            log("inventorySetOnHandQuantities failed:", e);
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

      const live = quickPrice != null || quickQty != null || (quickVariants && quickVariants.length > 0);
      return res.status(200).json({
        ok: true,
        review: adminNeedsReview,
        note: adminNeedsReview
          ? `Price/stock updated live where possible.${live ? " Other changes queued for admin review." : ""}`
          : live
          ? "Updated live on Shopify."
          : "No changes detected.",
      });
    } catch (e) {
      return bad(res, 500, "update/exception", e);
    }
  } catch (e: any) {
    console.error("update endpoint fatal:", e?.message || e);
    return bad(res, 500, "fatal", e);
  } finally {
    log("done in", Date.now() - started, "ms");
  }
}
