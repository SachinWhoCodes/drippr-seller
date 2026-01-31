// pages/api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

/* ---------------- helpers ---------------- */
const normSku = (s: string) =>
  String(s || "").trim().toUpperCase().replace(/\s+/g, "-");

const skuClaimId = (uid: string, sku: string) =>
  `${uid}__${normSku(sku)}`;

/* ---------------- GQL ---------------- */

const PRODUCT_CREATE = `
mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) {
    product { id }
    userErrors { message }
  }
}`;

const VARIANTS_BULK_CREATE = `
mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { message }
  }
}`;

const VARIANTS_BULK_UPDATE = `
mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { message }
  }
}`;

const PRODUCT_IMAGES_QUERY = `
query productImages($id: ID!) {
  product(id: $id) {
    images(first: 100) { nodes { url } }
  }
}`;

/* ---------------- utils ---------------- */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchCdnUrlsWithRetry(productId: string) {
  for (let i = 0; i < 6; i++) {
    const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
    const urls = r?.data?.product?.images?.nodes?.map((n: any) => n.url) || [];
    if (urls.length) return urls;
    await sleep(700 * (i + 1));
  }
  return [];
}

/* ---------------- handler ---------------- */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  let claimedSkuRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const token = String(req.headers.authorization || "").replace("Bearer ", "");
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid;

    const {
      title,
      description,
      vendor,
      productType,
      tags = [],
      resourceUrls = [],
      variantDraft,
      price,
      compareAtPrice
    } = req.body;

    /* ---------- STEP 1: OPTIONS ---------- */
    const rows = Object.values(variantDraft || {}) as any[];
    const optionNames = rows[0].optionValues.map((o: any) => o.name);

    /* ---------- STEP 2: SKU CLAIM ---------- */
    const docRef = adminDb.collection("merchantProducts").doc();
    const baseSku = normSku(rows[0].sku);
    const claimRef = adminDb
      .collection("skuClaims")
      .doc(skuClaimId(merchantId, baseSku));

    await claimRef.create({ merchantId, productDocId: docRef.id });
    claimedSkuRef = claimRef;

    /* ---------- STEP 3: CREATE PRODUCT ---------- */
    const productRes = await shopifyGraphQL(PRODUCT_CREATE, {
      product: {
        title,
        descriptionHtml: description || "",
        vendor,
        productType,
        status: "DRAFT",
        options: optionNames,
        tags: [...new Set([`merchant:${merchantId}`, ...tags])]
      },
      media: resourceUrls.map((u: string) => ({
        originalSource: u,
        mediaContentType: "IMAGE"
      }))
    });

    const productId = productRes.data.productCreate.product.id;

    /* ---------- STEP 4: CREATE VARIANTS ---------- */
    const variantsPayload = rows.map(v => ({
      sku: normSku(v.sku),
      price: String(v.price || price),
      compareAtPrice: String(v.compareAtPrice || compareAtPrice || price),
      options: v.optionValues.map((o: any) => o.value)
    }));

    const vCreate = await shopifyGraphQL(VARIANTS_BULK_CREATE, {
      productId,
      variants: variantsPayload
    });

    const variants = vCreate.data.productVariantsBulkCreate.productVariants;

    /* ---------- STEP 5: INVENTORY META ---------- */
    await shopifyGraphQL(VARIANTS_BULK_UPDATE, {
      productId,
      variants: variants.map((v: any) => ({
        id: v.id,
        inventoryItem: { tracked: true }
      }))
    });

    /* ---------- STEP 6: IMAGES ---------- */
    const cdnUrls = await fetchCdnUrlsWithRetry(productId);

    /* ---------- STEP 7: FIRESTORE ---------- */
    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      shopifyProductId: productId,
      shopifyVariantIds: variants.map((v: any) => v.id),
      shopifyVariantNumericIds: variants.map((v: any) => v.id.split("/").pop()),
      image: cdnUrls[0] || null,
      images: cdnUrls,
      variantDraft,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    return res.status(200).json({ ok: true, productId });

  } catch (e: any) {
    if (claimedSkuRef) await claimedSkuRef.delete().catch(() => {});
    return res.status(500).json({ ok: false, error: e.message });
  }
}
