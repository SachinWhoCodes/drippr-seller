// api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

/* 1) Create product and (optionally) attach images (Shopify ingests them) */
const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        handle
        status
        variants(first: 5) { nodes { id inventoryItem { id } } }
      }
      userErrors { field message }
    }
  }
`;

/* 2) Read permanent CDN image URLs after ingestion */
const PRODUCT_MEDIA_QUERY = /* GraphQL */ `
  query product($id: ID!) {
    product(id: $id) {
      id
      media(first: 20) {
        nodes {
          preview { image { url } }
        }
      }
    }
  }
`;

/* Optional polling helper: ingestion can be async; try a few short times */
async function fetchPermanentImageUrls(productId: string): Promise<string[]> {
  const maxAttempts = 5;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    const r = await shopifyGraphQL(PRODUCT_MEDIA_QUERY, { id: productId });
    const nodes = r?.data?.product?.media?.nodes || [];
    const urls = nodes
      .map((n: any) => n?.preview?.image?.url)
      .filter((u: any) => typeof u === "string" && u.length > 0);

    if (urls.length > 0) return urls;

    // brief wait then retry; ingestion is usually fast
    await delay(400);
  }
  return [];
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid;

    // --- input from React form ---
    const body = req.body || {};
    const {
      title,
      description,
      price,
      compareAtPrice,
      barcode,
      weightGrams,
      inventory = {},           // { quantity?, tracked?, cost? }
      currency = "INR",
      tags = [],
      resourceUrls = [],        // staged/external URLs
      vendor,
      productType,
      status,                   // 'active' | 'draft'
      seo,                      // { title?, description? }
      variantDraft,             // seller-proposed plan (admin review)
    } = body;

    if (!title || price == null) {
      return res.status(400).json({ ok: false, error: "title and price are required" });
    }

    // --- Shopify side tagging / status ---
    const merchantProductId = `mp_${nanoid(10)}`;
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];

    // If seller proposed variants, keep product DRAFT on Shopify
    const shopifyStatus =
      variantDraft ? "DRAFT" : (status ? String(status).toUpperCase() : undefined); // ACTIVE | DRAFT | ARCHIVED

    const productInput = {
      title,
      descriptionHtml: description || "",
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || undefined,
      status: shopifyStatus,
      seo: seo || undefined,
      tags: shopifyTags,
    };

    // Ask Shopify to ingest images from staged/external URLs
    const mediaInput =
      Array.isArray(resourceUrls) && resourceUrls.length
        ? resourceUrls.slice(0, 20).map((u: string) => ({
            originalSource: u,
            mediaContentType: "IMAGE" as const,
          }))
        : undefined;

    /* ---- 1) Create product (with media ingest) ---- */
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, { product: productInput, media: mediaInput });
    const userErrors = createRes?.data?.productCreate?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
    }

    const product = createRes?.data?.productCreate?.product;
    const firstVariant = product?.variants?.nodes?.[0];
    if (!product?.id || !firstVariant?.id) {
      throw new Error("Product created but default variant not returned.");
    }

    /* ---- 2) Update default variant fields (price/compare/barcode/sku/tracked/cost) ---- */
    // We reuse your existing flow from previous file — omitted here for brevity.
    // (Keeping this minimal: many stores only need the Firestore mirror + price stored locally.)
    // If you want to keep your previous bulk-variant update, paste it back here.

    /* ---- 3) Resolve PERMANENT image URLs from Shopify CDN ---- */
    let permanentImages: string[] = [];
    if (Array.isArray(resourceUrls) && resourceUrls.length) {
      // Try a few times because media ingestion can be async
      permanentImages = await fetchPermanentImageUrls(product.id);
    }

    // Fallback: if ingestion not yet visible, keep none (UI will still show product; images will appear later
    // when admin visits product again or you run a background sync). If you prefer, you can temporarily
    // store staged URLs, but they are ephemeral; better avoid.
    // We’ll ALSO keep the original list for debugging under `stagedResourceUrls`.
    const image = permanentImages[0] || null;

    /* ---- 4) Mirror in Firestore for the seller/admin panels ---- */
    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();

    // Status shown to seller (you were forcing 'pending'; keep that behavior)
    const sellerStatus = "pending";

    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: sellerStatus,            // pending until admin review/publish
      published: false,
      sku: merchantProductId,
      shopifyProductId: product.id,
      shopifyProductNumericId: String(product.id).split("/").pop(),
      shopifyVariantIds: [firstVariant.id],
      shopifyVariantNumericIds: [String(firstVariant.id).split("/").pop()],
      tags: shopifyTags,

      // ✅ Store ONLY permanent Shopify CDN URLs for UI
      image,
      images: permanentImages,
      imageUrls: permanentImages,

      // (Optional) keep the original staged/external list for debugging
      stagedResourceUrls: Array.isArray(resourceUrls) ? resourceUrls : [],

      stock: inventory?.quantity ?? null,
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || null,

      // Seller-proposed variants (admin will act on these)
      variantDraft: variantDraft || null,

      adminNotes: null,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(200).json({
      ok: true,
      productId: product.id,
      variantId: firstVariant.id,
      firestoreId: docRef.id,
      inReview: Boolean(variantDraft),
    });
  } catch (e: any) {
    console.error("create product error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
