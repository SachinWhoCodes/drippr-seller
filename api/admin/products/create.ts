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

// Updated to return all created variants and include Options
const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        title
        handle
        status
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
      images(first: 100) {
        nodes { url }
      }
    }
  }
`;

/* ---------------- utils ---------------- */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listCdnImageUrls(productId: string): Promise<string[]> {
  const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
  const nodes = r?.data?.product?.images?.nodes || [];
  return nodes.map((n: any) => String(n.url)).filter(Boolean);
}

async function fetchCdnUrlsWithRetry(productId: string): Promise<string[]> {
  const tries = 6;
  const baseDelay = 700;
  for (let i = 0; i < tries; i++) {
    const urls = await listCdnImageUrls(productId);
    if (urls.length) return urls;
    await sleep(baseDelay * (i + 1));
  }
  return [];
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  let claimedSkuRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    const { adminAuth, adminDb } = getAdmin();

    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid as string;

    const body = req.body || {};
    const {
      title, description, price, compareAtPrice, barcode,
      inventory = {}, currency = "INR", tags = [],
      resourceUrls = [], vendor, productType, status,
      seo, sku: rawSku, variantDraft,
    } = body;

    if (!title || price == null || !vendor || !rawSku) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    const sku = normSku(rawSku);

    // --- 1. Prepare Shopify Variants & Options ---
    let shopifyVariants: any[] = [];
    let shopifyOptions: string[] = [];

    if (variantDraft && Object.keys(variantDraft).length > 0) {
      const rows = Object.values(variantDraft) as any[];
      // Extract option names from the first variant (e.g., ["Size", "Color"])
      shopifyOptions = rows[0].optionValues.map((ov: any) => ov.name);

      shopifyVariants = rows.map((v) => ({
        price: String(v.price || price),
        compareAtPrice: v.compareAtPrice ? String(v.compareAtPrice) : String(compareAtPrice),
        sku: normSku(v.sku),
        barcode: v.barcode || undefined,
        options: v.optionValues.map((ov: any) => ov.value),
        inventoryItem: { tracked: true },
        inventoryQuantities: v.stock ? [{ 
          availableQuantity: Number(v.stock), 
          locationId: process.env.SHOPIFY_LOCATION_ID 
        }] : []
      }));
    } else {
      // Single product fallback
      shopifyVariants = [{
        price: String(price),
        compareAtPrice: String(compareAtPrice),
        sku: sku,
        barcode: barcode || undefined,
        inventoryItem: { tracked: inventory.tracked ?? true },
        inventoryQuantities: inventory.quantity ? [{ 
          availableQuantity: Number(inventory.quantity), 
          locationId: process.env.SHOPIFY_LOCATION_ID 
        }] : []
      }];
    }

    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];
    
    // --- 2. Build Product Input ---
    const productInput = {
      title,
      descriptionHtml: description || "",
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || undefined,
      status: variantDraft ? "DRAFT" : (status ? String(status).toUpperCase() : "ACTIVE"),
      seo: seo || undefined,
      tags: shopifyTags,
      options: shopifyOptions,
      variants: shopifyVariants, // All variants sent here
    };

    const mediaInput = resourceUrls.map((u: string) => ({
      originalSource: u,
      mediaContentType: "IMAGE",
    }));

    // --- 3. SKU Claim ---
    const docRef = adminDb.collection("merchantProducts").doc();
    const claimRef = adminDb.collection("skuClaims").doc(skuClaimId(merchantId, sku));
    try {
      await claimRef.create({ merchantId, productDocId: docRef.id, createdAt: Date.now() });
      claimedSkuRef = claimRef;
    } catch {
      return res.status(409).json({ ok: false, error: "Base SKU already used" });
    }

    // --- 4. Shopify Create ---
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, { product: productInput, media: mediaInput });
    const userErrors = createRes?.data?.productCreate?.userErrors || [];
    if (userErrors.length) {
      throw new Error(userErrors.map((e: any) => e.message).join("; "));
    }

    const product = createRes.data.productCreate.product;
    const variantsCreated = product.variants.nodes;

    // --- 5. Image Processing ---
    let cdnUrls = await fetchCdnUrlsWithRetry(product.id);

    // --- 6. Firestore Mirroring ---
    const allVariantIds = variantsCreated.map((v: any) => v.id);
    const allNumericVariantIds = allVariantIds.map((id: string) => id.split("/").pop());

    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: "pending",
      published: false,
      sku,
      shopifyProductId: product.id,
      shopifyProductNumericId: String(product.id).split("/").pop(),
      shopifyVariantIds: allVariantIds, // Full list synced
      shopifyVariantNumericIds: allNumericVariantIds,
      tags: shopifyTags,
      image: cdnUrls[0] || null,
      images: cdnUrls,
      imageUrls: cdnUrls,
      stock: variantDraft ? null : (inventory?.quantity ?? null),
      vendor,
      productType: productType || null,
      variantDraft: variantDraft || null, 
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return res.status(200).json({
      ok: true,
      productId: product.id,
      firestoreId: docRef.id,
    });

  } catch (e: any) {
    if (claimedSkuRef) await claimedSkuRef.delete().catch(() => {});
    console.error("Creation Error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}