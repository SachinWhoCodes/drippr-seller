// api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

// 1) Create product (new API). You can also attach media here.
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

// 2) Update the (auto-created) default variant with price & SKU
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

    // --- input ---
    const body = req.body || {};
    const {
      title,
      description, // plain text/HTML from your form
      price,
      currency = "INR",
      tags = [],
      resourceUrls = [], // staged upload resourceUrl(s) from /uploads/start
      vendor,
      productType,
      status, // "active" | "draft" from UI
      seo,    // { title, description } optional
    } = body;

    if (!title || price == null) {
      return res.status(400).json({ ok: false, error: "title and price are required" });
    }

    // --- build ProductCreateInput ---
    const merchantProductId = `mp_${nanoid(10)}`;
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];
    const shopifyStatus = status ? String(status).toUpperCase() : undefined; // ACTIVE | DRAFT | ARCHIVED

    const productInput = {
      title,
      descriptionHtml: description || "",             // ⬅️ replaces bodyHtml
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || undefined,
      status: shopifyStatus,                          // ProductStatus enum
      seo: seo || undefined,                          // {title, description}
      tags: shopifyTags,
      // No "variants" here in 2025-01
      // No "productOptions" => Shopify will create a single default variant
    };

    // Optionally attach media at creation time
    const mediaInput = Array.isArray(resourceUrls) && resourceUrls.length
      ? resourceUrls.slice(0, 10).map((u: string) => ({
          originalSource: u,
          mediaContentType: "IMAGE" as const,
        }))
      : undefined;

    // --- create product ---
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, {
      product: productInput,
      media: mediaInput,
    });

    const userErrors = createRes.data?.productCreate?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") });
    }

    const product = createRes.data.productCreate.product;
    const firstVariant = product?.variants?.nodes?.[0];
    if (!product?.id || !firstVariant?.id) {
      throw new Error("Product created but default variant not returned.");
    }

    // --- set price + SKU on default variant ---
    const variantsPayload = [
      {
        id: firstVariant.id,
        price: String(price),
        sku: merchantProductId,        // <-- set Variant.sku (not inventoryItem.sku)
      },
    ];

    const updateRes = await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: variantsPayload,
    });

    const vErrors = updateRes.data?.productVariantsBulkUpdate?.userErrors || [];
    if (vErrors.length) {
      // Non-fatal — still persist product but surface warning
      console.warn("productVariantsBulkUpdate errors:", vErrors);
    }

    // --- persist mirror in Firestore ---
    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();
    const numericVariantId = String(firstVariant.id).split("/").pop();
    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: (shopifyStatus || "ACTIVE").toLowerCase(),
      sku: merchantProductId,
      shopifyProductId: product.id,
      shopifyVariantIds: [firstVariant.id],
      shopifyVariantNumericIds: [numericVariantId],
      tags: shopifyTags,
      imageUrls: resourceUrls || [],
      inventoryQty: null, // set later via inventory mutations if you need
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
