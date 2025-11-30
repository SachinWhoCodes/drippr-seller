// api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

/* ---------------- GraphQL ---------------- */

// Create product and (optionally) attach images
const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product { id title handle status variants(first: 5) { nodes { id inventoryItem { id } } } }
      userErrors { field message }
    }
  }
`;

// Update default variant (price / compareAt / barcode / inventoryItem.*)
const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

// Read product images (CDN)
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

/* ---------------- Helpers ---------------- */

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function listImageUrls(productId: string): Promise<string[]> {
  const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
  const nodes = r?.data?.product?.images?.nodes || [];
  return nodes.map((n: any) => String(n?.url)).filter(Boolean);
}

/**
 * Poll Shopify until at least `minExpected` images are visible on CDN,
 * or until timeout is reached. Returns whatever is visible at the end.
 */
async function waitForShopifyImages(productId: string, minExpected: number, timeoutMs = 15000, intervalMs = 1000) {
  const start = Date.now();
  let urls: string[] = [];
  do {
    urls = await listImageUrls(productId);
    if (urls.length >= minExpected) return urls;
    await sleep(intervalMs);
  } while (Date.now() - start < timeoutMs);
  return urls; // best-effort
}

/* ---------------- Handler ---------------- */

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

    // --- input ---
    const body = req.body || {};
    const {
      title,
      description,
      price,
      compareAtPrice,
      barcode,
      weightGrams,
      inventory = {},
      currency = "INR",
      tags = [],
      resourceUrls = [],        // staged resource URLs from client
      vendor,
      productType,
      status,
      seo,
      variantDraft,
    } = body;

    if (!title || price == null) {
      return res.status(400).json({ ok: false, error: "title and price are required" });
    }

    // --- Shopify side tagging / status ---
    const merchantProductId = `mp_${nanoid(10)}`;
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];

    // If seller provided variant plan, keep product as Draft
    const shopifyStatus = variantDraft ? "DRAFT" : (status ? String(status).toUpperCase() : undefined);

    const productInput = {
      title,
      descriptionHtml: description || "",
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || undefined,
      status: shopifyStatus,
      seo: seo || undefined,
      tags: shopifyTags,
    };

    const mediaInput =
      Array.isArray(resourceUrls) && resourceUrls.length
        ? resourceUrls.slice(0, 10).map((u: string) => ({
            originalSource: u,
            mediaContentType: "IMAGE" as const,
          }))
        : undefined;

    // 1) Create product (and attach staged images if provided)
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, { product: productInput, media: mediaInput });
    const userErrors = createRes?.data?.productCreate?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
    }

    const product = createRes.data.productCreate.product;
    const firstVariant = product?.variants?.nodes?.[0];
    if (!product?.id || !firstVariant?.id) throw new Error("Product created but default variant not returned.");

    // 2) Update default variant fields
    const variantsPayload: any[] = [{
      id: firstVariant.id,
      price: String(price),
      ...(compareAtPrice != null ? { compareAtPrice: String(compareAtPrice) } : {}),
      ...(barcode ? { barcode } : {}),
      inventoryItem: {
        sku: merchantProductId,
        ...(typeof inventory.tracked === "boolean" ? { tracked: Boolean(inventory.tracked) } : {}),
        ...(inventory?.cost != null && inventory.cost !== "" ? { cost: String(inventory.cost) } : {}),
      },
    }];

    const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, { productId: product.id, variants: variantsPayload });
    const vErrors = updateRes?.data?.productVariantsBulkUpdate?.userErrors || [];
    if (vErrors.length) console.warn("productVariantsBulkUpdate errors:", vErrors);

    // 3) IMPORTANT: Wait for Shopify to finish processing media, then read CDN URLs
    const expectedImages = Array.isArray(mediaInput) ? mediaInput.length : 0;
    const cdnUrls = expectedImages ? await waitForShopifyImages(product.id, expectedImages) : [];

    // 4) Mirror in Firestore with CDN URLs (never write staged URLs)
    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();
    const numericVariantId = String(firstVariant.id).split("/").pop();

    const sellerStatus = "pending"; // your current logic

    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: sellerStatus,
      published: false,
      sku: merchantProductId,
      shopifyProductId: product.id,
      shopifyProductNumericId: String(product.id).split("/").pop(),
      shopifyVariantIds: [firstVariant.id],
      shopifyVariantNumericIds: [numericVariantId],
      tags: shopifyTags,
      image: cdnUrls[0] || null,
      images: cdnUrls,
      imageUrls: cdnUrls, // keep legacy key but use CDN
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
    console.error("create product error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}

