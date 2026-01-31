import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

/* ---------------- helpers ---------------- */
function normSku(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "-");
}
function skuClaimId(uid: string, sku: string) {
  return `${uid}__${normSku(sku)}`;
}

/* ---------------- Shopify GQL ---------------- */

// 1) Create product (NO custom variants)
const PRODUCT_CREATE = /* GraphQL */ `
mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) {
    product {
      id
      variants(first: 1) {
        nodes { id inventoryItem { id } }
      }
    }
    userErrors { field message }
  }
}
`;

// 2) Update default variant (price / sku / barcode / inventory meta)
const VARIANTS_BULK_UPDATE = /* GraphQL */ `
mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}
`;

// 3) Create additional variants (Shopify-recommended)
const VARIANTS_BULK_CREATE = /* GraphQL */ `
mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { field message }
  }
}
`;

// 4) Fetch permanent CDN image URLs
const PRODUCT_IMAGES_QUERY = /* GraphQL */ `
query productImages($id: ID!) {
  product(id: $id) {
    images(first: 100) { nodes { url } }
  }
}
`;

/* ---------------- utils ---------------- */
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchCdnUrlsWithRetry(productId: string): Promise<string[]> {
  for (let i = 0; i < 6; i++) {
    const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
    const urls =
      r?.data?.product?.images?.nodes?.map((n: any) => n.url) || [];
    if (urls.length) return urls;
    await sleep(700 * (i + 1));
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

    /* ---------- AUTH ---------- */
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    if (!token) return res.status(401).json({ ok: false });

    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid as string;

    /* ---------- INPUT ---------- */
    const {
      title,
      description,
      price,
      compareAtPrice,
      barcode,
      inventory = {},
      currency = "INR",
      tags = [],
      resourceUrls = [],
      vendor,
      productType,
      status,
      seo,
      sku: rawSku,
      variantDraft
    } = req.body;

    if (!title || price == null || !vendor || !rawSku) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const baseSku = normSku(rawSku);

    const hasVariants =
      variantDraft && Object.keys(variantDraft).length > 0;

    /* ---------- SKU CLAIM (same as working version) ---------- */
    const docRef = adminDb.collection("merchantProducts").doc();
    const claimRef = adminDb
      .collection("skuClaims")
      .doc(skuClaimId(merchantId, baseSku));

    try {
      await claimRef.create({
        merchantId,
        productDocId: docRef.id,
        createdAt: Date.now()
      });
      claimedSkuRef = claimRef;
    } catch {
      return res.status(409).json({ ok: false, error: "SKU already used" });
    }

    /* ---------- 1) CREATE PRODUCT ---------- */
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, {
      product: {
        title,
        descriptionHtml: description || "",
        vendor,
        productType: productType || undefined,
        status: status ? String(status).toUpperCase() : "DRAFT",
        seo: seo || undefined,
        tags: [...new Set([`merchant:${merchantId}`, ...tags])]
      },
      media: resourceUrls.map((u: string) => ({
        originalSource: u,
        mediaContentType: "IMAGE"
      }))
    });

    const userErrors = createRes?.data?.productCreate?.userErrors || [];
    if (userErrors.length) {
      throw new Error(userErrors.map((e: any) => e.message).join("; "));
    }

    const product = createRes.data.productCreate.product;
    const firstVariant = product.variants.nodes[0];

    if (!product?.id || !firstVariant?.id) {
      throw new Error("Product created but variant missing");
    }

    /* ---------- 2) UPDATE DEFAULT VARIANT ---------- */
    await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: [
        {
          id: firstVariant.id,
          price: String(price),
          ...(compareAtPrice != null
            ? { compareAtPrice: String(compareAtPrice) }
            : {}),
          ...(barcode ? { barcode } : {}),
          inventoryItem: {
            sku: baseSku,
            ...(typeof inventory.tracked === "boolean"
              ? { tracked: inventory.tracked }
              : {})
          }
        }
      ]
    });

    /* ---------- 3) CREATE ADDITIONAL VARIANTS (NEW) ---------- */
    let allVariantIds: string[] = [firstVariant.id];

    if (hasVariants) {
      const rows = Object.values(variantDraft) as any[];

      const variantsPayload = rows.map(v => ({
        sku: normSku(v.sku),
        price: String(v.price ?? price),
        compareAtPrice: String(
          v.compareAtPrice ?? compareAtPrice ?? price
        ),
        options: v.optionValues.map((o: any) => o.value)
      }));

      const vCreateRes = await shopifyGraphQL(
        VARIANTS_BULK_CREATE,
        {
          productId: product.id,
          variants: variantsPayload
        }
      );

      const vErrors =
        vCreateRes?.data?.productVariantsBulkCreate?.userErrors || [];
      if (vErrors.length) {
        throw new Error(vErrors.map((e: any) => e.message).join("; "));
      }

      const created =
        vCreateRes.data.productVariantsBulkCreate.productVariants;

      allVariantIds.push(...created.map((v: any) => v.id));
    }

    /* ---------- 4) CDN IMAGES ---------- */
    const cdnUrls = await fetchCdnUrlsWithRetry(product.id);

    /* ---------- 5) FIRESTORE SYNC ---------- */
    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      sku: baseSku,
      shopifyProductId: product.id,
      shopifyProductNumericId: product.id.split("/").pop(),
      shopifyVariantIds: allVariantIds,
      shopifyVariantNumericIds: allVariantIds.map(id =>
        id.split("/").pop()
      ),
      image: cdnUrls[0] || null,
      images: cdnUrls,
      imageUrls: cdnUrls,
      stock: inventory?.quantity ?? null,
      vendor,
      productType: productType || null,
      variantDraft: hasVariants ? variantDraft : null,
      status: "pending",
      published: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    return res.status(200).json({
      ok: true,
      productId: product.id,
      variantIds: allVariantIds
    });

  } catch (e: any) {
    try {
      if (claimedSkuRef) await claimedSkuRef.delete();
    } catch {}
    console.error("create product error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
