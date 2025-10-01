// imports
import { getAdmin } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminAuth, adminDb } = getAdmin();

    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });

    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid;

    const {
      title, description, price,
      currency = "INR",
      tags = [],
      resourceUrls = [],
      vendor,
      productType,
      status,
      seo
    } = req.body || {};

    if (!title || !price) return res.status(400).json({ ok: false, error: "title and price are required" });

    const PRODUCT_CREATE = `
      mutation ProductCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id title handle tags productType vendor status
            variants(first: 10) { nodes { id sku inventoryItem { id } } }
          }
          userErrors { field message }
        }
      }
    `;
    const METAFIELDS_SET = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key }
          userErrors { field message }
        }
      }
    `;
    const PRODUCT_CREATE_MEDIA = `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { id status preview { image { url } } }
          mediaUserErrors { field message code }
        }
      }
    `;

    const merchantProductId = `mp_${nanoid(10)}`;
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];
    const shopifyStatus = status ? String(status).toUpperCase() : undefined;

    const createRes = await shopifyGraphQL(PRODUCT_CREATE, {
      input: {
        title,
        bodyHtml: description || "",
        vendor: vendor || "DRIPPR Marketplace",
        productType: productType || undefined,
        tags: shopifyTags,
        variants: [{ price: String(price), sku: merchantProductId }],
        status: shopifyStatus,
        seo: seo || undefined,
      },
    });

    const product = createRes.data.productCreate.product;
    const variant = product.variants.nodes[0];

    await shopifyGraphQL(METAFIELDS_SET, {
      metafields: [
        { ownerId: product.id, namespace: "marketplace", key: "merchant_id", type: "single_line_text_field", value: merchantId },
        { ownerId: product.id, namespace: "marketplace", key: "merchant_product_id", type: "single_line_text_field", value: merchantProductId },
      ],
    });

    if (Array.isArray(resourceUrls) && resourceUrls.length) {
      const media = resourceUrls.slice(0, 10).map((url: string) => ({
        originalSource: url,
        mediaContentType: "IMAGE",
      }));
      const mediaRes = await shopifyGraphQL(PRODUCT_CREATE_MEDIA, { productId: product.id, media });
      if (mediaRes.data.productCreateMedia.mediaUserErrors?.length) {
        console.warn("mediaUserErrors", mediaRes.data.productCreateMedia.mediaUserErrors);
      }
    }

    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();
    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: shopifyStatus?.toLowerCase() || "active",
      sku: merchantProductId,
      shopifyProductId: product.id,
      shopifyVariantIds: [variant.id],
      tags: shopifyTags,
      imageUrls: resourceUrls || [],
      inventoryQty: null,
      createdAt: now,
      updatedAt: now,
      vendor: vendor || "DRIPPR Marketplace",
      productType: productType || null,
    });

    return res.status(200).json({
      ok: true,
      merchantProductId,
      productId: product.id,
      variantId: variant.id,
      firestoreId: docRef.id,
    });
  } catch (e: any) {
    console.error("create product error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
