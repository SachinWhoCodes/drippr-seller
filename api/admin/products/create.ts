// api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

// 1) Create product and (optionally) attach images
const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        title
        handle
        status
        variants(first: 5) {
          nodes {
            id
            inventoryItem { id }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

// 2) Update default variant (price, compareAtPrice, barcode, weight, inventoryItem.*)
const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
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

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid;

    // --- input from the React form ---
    const body = req.body || {};
    const {
      title,
      description,                 // plain text/HTML
      price,                       // required
      compareAtPrice,              // optional
      barcode,                     // optional
      weightGrams,                 // optional number (grams)
      inventory = {},              // { quantity?, tracked?, cost? }
      currency = "INR",
      tags = [],
      resourceUrls = [],           // staged upload resourceUrl(s)
      vendor,
      productType,
      status,                      // 'active' | 'draft'
      seo,                         // { title?, description? }
    } = body;

    if (!title || price == null) {
      return res.status(400).json({ ok: false, error: "title and price are required" });
    }

    const merchantProductId = `mp_${nanoid(10)}`;
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];
    const shopifyStatus = status ? String(status).toUpperCase() : undefined; // ACTIVE | DRAFT | ARCHIVED

    const productInput = {
      title,
      descriptionHtml: description || "",
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || undefined,
      status: shopifyStatus,
      seo: seo || undefined, // { title?, description? }
      tags: shopifyTags,
      // Let Shopify create the single default variant
    };

    const mediaInput =
      Array.isArray(resourceUrls) && resourceUrls.length
        ? resourceUrls.slice(0, 10).map((u: string) => ({
            originalSource: u,
            mediaContentType: "IMAGE" as const,
          }))
        : undefined;

    // --- 1) create product ---
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, { product: productInput, media: mediaInput });
    const userErrors = createRes.data?.productCreate?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
    }

    const product = createRes.data.productCreate.product;
    const firstVariant = product?.variants?.nodes?.[0];
    if (!product?.id || !firstVariant?.id) {
      throw new Error("Product created but default variant not returned.");
    }

    // --- 2) update default variant with all feasible fields ---
    const variantsPayload: any[] = [
      {
        id: firstVariant.id,
        price: String(price),
        ...(compareAtPrice != null && compareAtPrice !== ""
          ? { compareAtPrice: String(compareAtPrice) }
          : {}),
        ...(barcode ? { barcode } : {}),
        ...(weightGrams
          ? { weight: Number(weightGrams), weightUnit: "GRAMS" }
          : {}),
        inventoryItem: {
          sku: merchantProductId,                         // our traceable sku
          ...(typeof inventory.tracked === "boolean" ? { tracked: Boolean(inventory.tracked) } : {}),
          ...(inventory.cost != null && inventory.cost !== ""
            ? { cost: String(inventory.cost) }            // Decimal string
            : {}),
        },
      },
    ];

    const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: variantsPayload,
    });
    const vErrors = updateRes.data?.productVariantsBulkUpdate?.userErrors || [];
    if (vErrors.length) console.warn("productVariantsBulkUpdate errors:", vErrors);

    // NOTE: Setting absolute inventory quantity on Shopify requires a location ID
    // and a separate mutation (inventorySetOnHandQuantities / inventoryAdjustQuantities).
    // We’ll store the requested quantity locally for now and can wire the Shopify
    // location-based update when you’re ready.

    // --- 3) mirror in Firestore for the seller panel ---
    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();
    const numericVariantId = String(firstVariant.id).split("/").pop();

    // Keep field names your UI reads: image/images
    const images = Array.isArray(resourceUrls) ? resourceUrls : [];
    const image = images[0] || null;

    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: (shopifyStatus || "ACTIVE").toLowerCase(), // 'active' | 'draft'
      sku: merchantProductId,
      shopifyProductId: product.id,
      shopifyVariantIds: [firstVariant.id],
      shopifyVariantNumericIds: [numericVariantId],
      tags: shopifyTags,
      // For compatibility with your table rendering:
      image,                 // thumbnail
      images,                // array for gallery
      imageUrls: images,     // (kept too, in case other code already uses it)
      stock: inventory?.quantity ?? null, // saved locally; not yet pushed to Shopify location
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || null,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(200).json({
      ok: true,
      productId: product.id,
      variantId: firstVariant.id,
      merchantProductId,
      firestoreId: docRef.id,
    });
  } catch (e: any) {
    console.error("create product error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
