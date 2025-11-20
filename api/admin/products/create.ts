// api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

function normSku(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "-");
}
function skuClaimId(uid: string, sku: string) {
  return `${uid}__${normSku(sku)}`;
}

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

  let claimedSkuRef: FirebaseFirestore.DocumentReference | null = null;

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
      description,
      price,
      compareAtPrice, // mandatory per your request
      barcode,
      weightGrams,
      inventory = {},          // { quantity?, tracked?, cost? }  -> quantity mandatory in UI
      currency = "INR",
      tags = [],
      resourceUrls = [],
      vendor,                  // mandatory per your request
      productType,
      status,
      seo,                     // mandatory in UI
      sku: rawSku,             // mandatory per your request
      variantDraft,
    } = body;

    if (!title || price == null || !vendor || !rawSku || compareAtPrice == null) {
      return res.status(400).json({ ok: false, error: "title, price, vendor, sku and compareAtPrice are required" });
    }
    const sku = normSku(rawSku);

    // --- Shopify side tagging / status ---
    const merchantProductId = `mp_${nanoid(10)}`; // internal trace id if you still want it
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
        inventoryItem: {
          sku, // <-- write vendor-provided SKU
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

    const now = Date.now();
    const numericVariantId = String(firstVariant.id).split("/").pop();

    const images = Array.isArray(resourceUrls) ? resourceUrls : [];
    const image = images[0] || null;

    // Your seller-facing status: keep "pending" so admin can configure variants
    const sellerStatus = "pending";

    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: sellerStatus,
      published: false,
      sku,                       // <-- store vendor-provided SKU on our doc
      shopifyProductId: product.id,
      shopifyProductNumericId: String(product.id).split("/").pop(),
      shopifyVariantIds: [firstVariant.id],
      shopifyVariantNumericIds: [numericVariantId],
      tags: shopifyTags,
      image,
      images,
      imageUrls: images,
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
      merchantProductId,       // internal trace
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
