// api/admin/products/update.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import ImageKit from "imagekit";
import { shopifyGraphQL } from "../../_lib/shopify.js";

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
});

/* ---------- GQL (unchanged pieces omitted for brevity) ---------- */
const PRODUCT_IMAGES_QUERY = /* GraphQL */ `
  query productImages($id: ID!) {
    product(id: $id) {
      id
      images(first: 100) { nodes { id url } }
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
      media { id status }      # status may be PROCESSING then READY
      mediaUserErrors { field message }
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

/* ---------- Helpers ---------- */
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function listImageUrls(productId: string): Promise<{ idsByUrl: Record<string,string>, urls: string[] }> {
  const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
  const nodes = r?.data?.product?.images?.nodes || [];
  const idsByUrl: Record<string,string> = {};
  const urls = nodes.map((n: any) => {
    const u = String(n?.url);
    if (u && n?.id) idsByUrl[u] = String(n.id);
    return u;
  }).filter(Boolean);
  return { idsByUrl, urls };
}

async function waitForShopifyImages(productId: string, minExpected: number, timeoutMs = 15000, intervalMs = 1000) {
  const start = Date.now();
  let urls: string[] = [];
  do {
    const r = await listImageUrls(productId);
    urls = r.urls;
    if (urls.length >= minExpected) return urls;
    await sleep(intervalMs);
  } while (Date.now() - start < timeoutMs);
  return urls;
}

/* ---------- Handler ---------- */
export default async function handler(req: any, res: any) {
  try {
    const { adminAuth, adminDb } = getAdmin();

    // ...auth & other ops unchanged...

    if (req.method === "POST") {
      const body = req.body || {};
      const op = typeof body.op === "string" ? body.op : "";

      // (1) Stage targets for edit (unchanged)
      if (op === "imagesStage") {
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return res.status(400).json({ ok: false, error: "No files provided" });

        const input = files.map((f: any) => ({
          resource: "IMAGE",
          filename: String(f.filename || "image.jpg"),
          mimeType: String(f.mimeType || "image/jpeg"),
          fileSize: String(f.fileSize),
          httpMethod: "POST",
        }));

        const r = await shopifyGraphQL(STAGED_UPLOADS_CREATE, { input });
        const userErrors = r?.data?.stagedUploadsCreate?.userErrors || [];
        if (userErrors.length) {
          return res.status(400).json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
        }
        const targets = r?.data?.stagedUploadsCreate?.stagedTargets || [];
        return res.status(200).json({ ok: true, targets });
      }

      // (2) Attach staged images and mirror CDN URLs (CHANGED: add polling)
      if (op === "imagesAttach") {
        const mpDocId = String(body.id || "");
        const resourceUrls: string[] = Array.isArray(body.resourceUrls) ? body.resourceUrls : [];
        if (!mpDocId) return res.status(400).json({ ok: false, error: "Missing id" });
        if (!resourceUrls.length) return res.status(400).json({ ok: false, error: "No resourceUrls" });

        const ref = adminDb.collection("merchantProducts").doc(mpDocId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

        const doc = snap.data() || {};
        const uid = (await adminAuth.verifyIdToken(String(req.headers.authorization).replace(/^Bearer\s+/,""))).uid;
        if (doc.merchantId && doc.merchantId !== uid) return res.status(403).json({ ok: false, error: "Forbidden" });

        const shopifyProductId: string | undefined = doc.shopifyProductId;
        if (!shopifyProductId) return res.status(400).json({ ok: false, error: "No Shopify product id" });

        // Count images before attach so we know what "ready" looks like
        const before = await listImageUrls(shopifyProductId);
        const expected = before.urls.length + resourceUrls.length;

        const media = resourceUrls.map(u => ({ originalSource: u, mediaContentType: "IMAGE" as const }));
        const attachRes = await shopifyGraphQL(PRODUCT_CREATE_MEDIA, { productId: shopifyProductId, media });
        const mErrors = attachRes?.data?.productCreateMedia?.mediaUserErrors || [];
        if (mErrors.length) {
          return res.status(400).json({ ok: false, error: mErrors.map((e: any) => e.message).join("; ") });
        }

        // NEW: wait until Shopify finishes processing & images are visible on CDN
        const urls = await waitForShopifyImages(shopifyProductId, expected);

        await ref.set({ images: urls, image: urls[0] || null, imageUrls: urls, updatedAt: Date.now() }, { merge: true });
        return res.status(200).json({ ok: true, images: urls });
      }

      // (3) Delete images (unchanged, with final refresh)
      if (op === "imagesDelete") {
        const mpDocId = String(body.id || "");
        const urlsToDelete: string[] = Array.isArray(body.urls) ? body.urls : [];
        if (!mpDocId) return res.status(400).json({ ok: false, error: "Missing id" });
        if (!urlsToDelete.length) return res.status(400).json({ ok: false, error: "No urls" });

        const ref = adminDb.collection("merchantProducts").doc(mpDocId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

        const doc = snap.data() || {};
        const shopifyProductId: string | undefined = doc.shopifyProductId;
        if (!shopifyProductId) return res.status(400).json({ ok: false, error: "No Shopify product id" });

        const { idsByUrl } = await listImageUrls(shopifyProductId);
        for (const u of urlsToDelete) {
          const imgId = idsByUrl[u];
          if (!imgId) continue;
          try {
            const del = await shopifyGraphQL(PRODUCT_IMAGE_DELETE, { id: imgId });
            const errs = del?.data?.productImageDelete?.userErrors || [];
            if (errs.length) console.warn("productImageDelete errors:", errs);
          } catch (e) {
            console.warn("productImageDelete failed:", e);
          }
        }

        const refreshed = await waitForShopifyImages(shopifyProductId, 0);
        await ref.set({ images: refreshed, image: refreshed[0] || null, imageUrls: refreshed, updatedAt: Date.now() }, { merge: true });
        return res.status(200).json({ ok: true, images: refreshed });
      }

      // ...rest of your update handler (quick price/stock & review) stays the same...
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    console.error("update endpoint error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}

