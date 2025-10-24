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

// 2) Update default variant (price, compareAtPrice, barcode, inventoryItem.*)
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
      weightGrams,                 // optional number (grams) - not sent to Shopify here
      inventory = {},              // { quantity?, tracked?, cost? }
      currency = "INR",
      tags = [],
      resourceUrls = [],           // staged upload resourceUrl(s)
      vendor,
      productType,
      status,                      // 'active' | 'draft'
      seo,                         // { title?, description? }
      // NEW: seller-proposed variants (NOT sent to Shopify now)
      // { options: [{name, values:string[]}], variants: [{options[], title, price?, compareAtPrice?, sku?, quantity?, barcode?, weightGrams?}] }
      variantDraft,
    } = body;

    if (!title || price == null) {
      return res.status(400).json({ ok: false, error: "title and price are required" });
    }

    // --- Shopify side tagging / status ---
    const merchantProductId = `mp_${nanoid(10)}`;
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];

    // If seller provided variant plan, FORCE DRAFT on Shopify
    const shopifyStatus = variantDraft
      ? "DRAFT"
      : (status ? String(status).toUpperCase() : undefined); // ACTIVE | DRAFT | ARCHIVED

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

    // --- 1) create product on Shopify ---
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

    // --- 2) update default Shopify variant with feasible fields ---
    const variantsPayload: any[] = [
      {
        id: firstVariant.id,
        price: String(price),
        ...(compareAtPrice != null ? { compareAtPrice: String(compareAtPrice) } : {}),
        ...(barcode ? { barcode } : {}),
        // ⛔️ Avoid weight here (weight/weightUnit via this mutation isn’t stable across API versions).
        inventoryItem: {
          sku: merchantProductId, // traceable marketplace SKU
          ...(typeof inventory.tracked === "boolean" ? { tracked: Boolean(inventory.tracked) } : {}),
          ...(inventory?.cost != null && inventory.cost !== "" ? { cost: String(inventory.cost) } : {}),
        },
      },
    ];

    const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: variantsPayload,
    });
    const vErrors = updateRes.data?.productVariantsBulkUpdate?.userErrors || [];
    if (vErrors.length) console.warn("productVariantsBulkUpdate errors:", vErrors);

    // NOTE: Absolute on-hand quantity requires a location-based mutation.
    // We keep the requested quantity locally for now.

    // --- 3) mirror in Firestore for the seller/admin panels ---
    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();
    const numericVariantId = String(firstVariant.id).split("/").pop();

    const images = Array.isArray(resourceUrls) ? resourceUrls : [];
    const image = images[0] || null;

    // Status shown to seller:
    // - if variantDraft exists => "in_review"
    // - else mirror Shopify status (default to 'active')
    // const sellerStatus = variantDraft ? "pending" : (shopifyStatus || "ACTIVE").toLowerCase();
    const sellerStatus = "pending";
    
    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: sellerStatus,                   // 'active' | 'draft' | 'in_review'
      published: false,                       // admin will publish after variants are created
      sku: merchantProductId,
      shopifyProductId: product.id,
      shopifyProductNumericId: String(product.id).split("/").pop(),
      shopifyVariantIds: [firstVariant.id],
      shopifyVariantNumericIds: [numericVariantId],
      tags: shopifyTags,
      image,                 // thumbnail for your table
      images,                // gallery
      imageUrls: images,     // kept for backwards compatibility
      stock: inventory?.quantity ?? null, // local-only until you wire a Shopify location
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || null,
      // NEW: store the seller-proposed variant plan for the admin panel
      variantDraft: variantDraft || null,
      adminNotes: null,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(200).json({
      ok: true,
      productId: product.id,
      variantId: firstVariant.id,
      merchantProductId,
      firestoreId: docRef.id,
      inReview: Boolean(variantDraft),
    });
  } catch (e: any) {
    console.error("create product error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
