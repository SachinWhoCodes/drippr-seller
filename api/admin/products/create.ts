// pages/api/admin/products/create.ts
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

// We use the reliable creation mutation from your first code
const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        title
        variants(first: 100) { 
          nodes { 
            id 
            sku
            inventoryItem { id } 
          } 
        }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_IMAGES_QUERY = /* GraphQL */ `
  query productImages($id: ID!) {
    product(id: $id) {
      id
      images(first: 100) { nodes { url } }
    }
  }
`;

/* ---------------- Utils ---------------- */
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchCdnUrlsWithRetry(productId: string): Promise<string[]> {
  for (let i = 0; i < 6; i++) {
    const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
    const urls = r?.data?.product?.images?.nodes?.map((n: any) => n.url) || [];
    if (urls.length) return urls;
    await sleep(700 * (i + 1));
  }
  return [];
}

/* ---------------- Main Handler ---------------- */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  let claimedSkuRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    const { adminAuth, adminDb } = getAdmin();
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid;

    const {
      title, description, price, compareAtPrice, sku: rawSku,
      vendor, productType, tags = [], resourceUrls = [],
      variantDraft, inventory = {}
    } = req.body;

    const baseSku = normSku(rawSku);

    // --- STEP 1: Prepare Variants & Options (The Working Fix) ---
    let shopifyVariants: any[] = [];
    let shopifyOptions: string[] = [];

    if (variantDraft && Object.keys(variantDraft).length > 0) {
      const rows = Object.values(variantDraft) as any[];
      // Get option names like ["Size", "Color"]
      shopifyOptions = rows[0].optionValues.map((ov: any) => ov.name);
      
      shopifyVariants = rows.map((v) => ({
        price: String(v.price || price),
        compareAtPrice: String(v.compareAtPrice || compareAtPrice || price),
        sku: normSku(v.sku),
        options: v.optionValues.map((ov: any) => ov.value),
        inventoryItem: { tracked: true }
        // Note: We skip inventoryQuantities here to avoid LocationID errors that break 500
      }));
    } else {
      // Standard fallback from your first code
      shopifyVariants = [{
        price: String(price),
        compareAtPrice: String(compareAtPrice || price),
        sku: baseSku,
        inventoryItem: { tracked: inventory.tracked ?? true }
      }];
    }

    // --- STEP 2: SKU Claim ---
    const docRef = adminDb.collection("merchantProducts").doc();
    const claimRef = adminDb.collection("skuClaims").doc(skuClaimId(merchantId, baseSku));
    try {
      await claimRef.create({ merchantId, productDocId: docRef.id, createdAt: Date.now() });
      claimedSkuRef = claimRef;
    } catch {
      return res.status(409).json({ ok: false, error: "SKU already used" });
    }

    // --- STEP 3: Create on Shopify ---
    const productInput = {
      title,
      descriptionHtml: description || "",
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || "",
      status: "DRAFT", // Always start as draft for safety
      tags: [...new Set([`merchant:${merchantId}`, ...tags])],
      options: shopifyOptions.length > 0 ? shopifyOptions : undefined,
      variants: shopifyVariants
    };

    const mediaInput = resourceUrls.map((u: string) => ({
      originalSource: u,
      mediaContentType: "IMAGE"
    }));

    const createRes = await shopifyGraphQL(PRODUCT_CREATE, { product: productInput, media: mediaInput });
    
    if (createRes?.data?.productCreate?.userErrors?.length) {
      const err = createRes.data.productCreate.userErrors[0].message;
      throw new Error(err);
    }

    const product = createRes.data.productCreate.product;
    const variantsCreated = product.variants.nodes;

    // --- STEP 4: Image & ID Sync ---
    const cdnUrls = await fetchCdnUrlsWithRetry(product.id);
    const allVariantIds = variantsCreated.map((v: any) => v.id);
    const allNumericIds = allVariantIds.map((id: string) => id.split("/").pop());

    // --- STEP 5: Save to Firestore ---
    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      price: Number(price),
      sku: baseSku,
      shopifyProductId: product.id,
      shopifyVariantIds: allVariantIds, // This ensures orders show up!
      shopifyVariantNumericIds: allNumericIds,
      image: cdnUrls[0] || null,
      images: cdnUrls,
      status: "pending",
      variantDraft: variantDraft || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      vendor
    });

    return res.status(200).json({ ok: true, productId: product.id });

  } catch (e: any) {
    if (claimedSkuRef) await claimedSkuRef.delete().catch(() => {});
    return res.status(500).json({ ok: false, error: e.message });
  }
}