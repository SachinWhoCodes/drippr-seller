// pages/api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

/* ---------------- helpers: sku ---------------- */
function normSku(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "-");
}
function skuClaimId(uid: string, sku: string) {
  return `${uid}__${normSku(sku)}`;
}

/* ---------------- Shopify GQL ---------------- */

// Create product and (optionally) attach images (via staged resourceUrls)
const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        title
        handle
        status
        # media may not be ready instantly, so we DO NOT rely on this for URLs
        media(first: 10) {
          edges {
            node {
              mediaContentType
              ... on MediaImage {
                id
                image { url altText }
              }
            }
          }
        }
        variants(first: 5) { nodes { id inventoryItem { id } } }
      }
      userErrors { field message }
    }
  }
`;

// Definitive, permanent CDN URLs live here:
const PRODUCT_IMAGES_QUERY = /* GraphQL */ `
  query productImages($id: ID!) {
    product(id: $id) {
      id
      images(first: 100) {
        nodes { url }
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

/* ---------------- util: CDN fetch with retry ---------------- */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listCdnImageUrls(productId: string): Promise<string[]> {
  const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
  const nodes = r?.data?.product?.images?.nodes || [];
  return nodes.map((n: any) => String(n.url)).filter(Boolean);
}

/**
 * Poll Shopify a few times (short backoff) until CDN URLs appear.
 * We cap total wait to ~4 seconds so the UX is still snappy.
 */
async function fetchCdnUrlsWithRetry(productId: string): Promise<string[]> {
  const tries = 6;               // up to 6 attempts
  const baseDelay = 700;         // ms, simple linear backoff

  for (let i = 0; i < tries; i++) {
    const urls = await listCdnImageUrls(productId);
    if (urls.length) return urls;
    await sleep(baseDelay * (i + 1));
  }
  return [];
}

/* ---------------- handler ---------------- */

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let claimedSkuRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid as string;

    // --- input from the React form ---
    const body = req.body || {};
    const {
      title,
      description,
      price,
      compareAtPrice,             // mandatory in UI
      barcode,
      weightGrams,                // (unused here; weight fields removed from variant API)
      inventory = {},            // { quantity?, tracked?, cost? } -> quantity mandatory in UI
      currency = "INR",
      tags = [],
      resourceUrls = [],          // staged upload resource URLs from client
      vendor,                     // mandatory in UI
      productType,
      status,
      seo,                        // mandatory in UI
      sku: rawSku,                // mandatory in UI
      variantDraft,
    } = body;

    if (!title || price == null || !vendor || !rawSku || compareAtPrice == null) {
      return res.status(400).json({
        ok: false,
        error: "title, price, vendor, sku and compareAtPrice are required"
      });
    }
    const sku = normSku(rawSku);

    // --- Shopify side tagging / status ---
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];
    const shopifyStatus = variantDraft
      ? "DRAFT"
      : (status ? String(status).toUpperCase() : undefined); // ACTIVE | DRAFT | ARCHIVED

    const productInput = {
      title,
      descriptionHtml: description || "",
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || undefined,
      status: shopifyStatus,
      seo: seo || undefined,
      tags: shopifyTags,
    };

    // We still pass staged resourceUrls so Shopify can ingest them as media.
    const mediaInput =
      Array.isArray(resourceUrls) && resourceUrls.length
        ? resourceUrls.slice(0, 10).map((u: string) => ({
            originalSource: u,
            mediaContentType: "IMAGE" as const,
          }))
        : undefined;

    // --- SKU claim (per-vendor uniqueness) ---
    const docRef = adminDb.collection("merchantProducts").doc();
    const claimRef = adminDb.collection("skuClaims").doc(skuClaimId(merchantId, sku));
    try {
      await claimRef.create({ merchantId, productDocId: docRef.id, createdAt: Date.now() });
      claimedSkuRef = claimRef;
    } catch {
      return res.status(409).json({ ok: false, error: "SKU already used by you" });
    }

    // --- 1) create product on Shopify ---
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, { product: productInput, media: mediaInput });
    const userErrors = createRes?.data?.productCreate?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
    }

    const product = createRes.data.productCreate.product;
    const firstVariant = product?.variants?.nodes?.[0];
    if (!product?.id || !firstVariant?.id) {
      throw new Error("Product created but default variant not returned.");
    }

    // --- 2) Update default variant fields (price / compare / sku / inventory meta) ---
    const variantsPayload: any[] = [
      {
        id: firstVariant.id,
        price: String(price),
        ...(compareAtPrice != null ? { compareAtPrice: String(compareAtPrice) } : {}),
        ...(barcode ? { barcode } : {}),
        inventoryItem: {
          sku,
          ...(typeof inventory.tracked === "boolean" ? { tracked: Boolean(inventory.tracked) } : {}),
          ...(inventory?.cost != null && inventory.cost !== "" ? { cost: String(inventory.cost) } : {}),
        },
      },
    ];

    const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: variantsPayload,
    });
    const vErrors = updateRes?.data?.productVariantsBulkUpdate?.userErrors || [];
    if (vErrors.length) console.warn("productVariantsBulkUpdate errors:", vErrors);

    // --- 3) Fetch **permanent CDN** image URLs (retry briefly until ready) ---
    let cdnUrls: string[] = await fetchCdnUrlsWithRetry(product.id);

    // DO NOT fall back to staged resourceUrls. If CDN is not ready yet,
    // save no images now (UI will still work), they can be attached soon after.
    // This avoids ever persisting temporary URLs in Firestore.
    if (!cdnUrls.length) {
      console.warn("[create] CDN images not ready; saving without image URLs (no staged fallback).");
    }

    // --- 4) Mirror to Firestore (only CDN URLs) ---
    const now = Date.now();
    const numericVariantId = String(firstVariant.id).split("/").pop();
    const sellerStatus = "pending"; // unchanged

    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: sellerStatus,
      published: false,
      sku,
      shopifyProductId: product.id,
      shopifyProductNumericId: String(product.id).split("/").pop(),
      shopifyVariantIds: [firstVariant.id],
      shopifyVariantNumericIds: [numericVariantId],
      tags: shopifyTags,

      // PERMANENT ONLY:
      image: cdnUrls[0] || null,
      images: cdnUrls,
      imageUrls: cdnUrls,        // keep legacy field aligned

      stock: inventory?.quantity ?? null,
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || null,
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
    // release claimed SKU if we grabbed it
    try { if (claimedSkuRef) await claimedSkuRef.delete(); } catch {}
    console.error("create product error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
