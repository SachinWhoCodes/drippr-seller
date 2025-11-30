// pages/api/admin/products/create.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

/* ---------------- Shopify GQL ---------------- */

const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        handle
        title
        status
        variants(first: 5) {
          nodes { id inventoryItem { id } }
        }
        images(first: 20) { nodes { url } }
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

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

async function listImageUrls(productId: string): Promise<string[]> {
  const r = await shopifyGraphQL(PRODUCT_IMAGES_QUERY, { id: productId });
  const nodes = r?.data?.product?.images?.nodes || [];
  return nodes.map((n: any) => String(n.url)).filter(Boolean);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminAuth, adminDb } = getAdmin();

    // --- auth ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid as string;

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
      resourceUrls = [],        // <- staged resource URLs from client (optional)
      vendor,
      productType,
      status,
      seo,
      variantDraft,
    } = body;

    if (!title || price == null) {
      return res.status(400).json({ ok: false, error: "title and price are required" });
    }

    const merchantProductId = `mp_${nanoid(10)}`;
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];
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

    // When sending `media` with productCreate, Shopify attaches them and will
    // generate permanent CDN URLs shortly after.
    const mediaInput =
      Array.isArray(resourceUrls) && resourceUrls.length
        ? resourceUrls.slice(0, 10).map((u: string) => ({
            originalSource: u,
            mediaContentType: "IMAGE" as const,
          }))
        : undefined;

    const createRes = await shopifyGraphQL(PRODUCT_CREATE, { product: productInput, media: mediaInput });
    const uerr = createRes?.data?.productCreate?.userErrors || [];
    if (uerr.length) {
      return res.status(400).json({ ok: false, error: uerr.map((e: any) => e.message).join("; ") });
    }

    const product = createRes.data.productCreate.product;
    const firstVariant = product?.variants?.nodes?.[0];
    if (!product?.id || !firstVariant?.id) throw new Error("Product created but variant missing");

    // ===== IMPORTANT: mirror PERMANENT CDN URLs, never staged resourceUrl =====
    // Try to use images returned by productCreate; if empty, query once.
    let cdnUrls: string[] =
      (product.images?.nodes || []).map((n: any) => String(n.url)).filter(Boolean);

    if (!cdnUrls.length) {
      // Small lag can happen; one follow-up query is enough.
      cdnUrls = await listImageUrls(product.id);
    }

    // ===== Mirror to Firestore =====
    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();

    const numericVariantId = String(firstVariant.id).split("/").pop();
    const sellerStatus = "pending"; // unchanged behavior: admin review flow

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

      // Save ONLY CDN permanent URLs
      image: cdnUrls[0] || null,
      images: cdnUrls,
      imageUrls: cdnUrls,              // backward-compat field you were using

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

