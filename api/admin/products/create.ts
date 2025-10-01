// /api/admin/products/create.ts
import { adminAuth, adminDb } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";
import { nanoid } from "nanoid";

const PRODUCT_CREATE = `
mutation ProductCreate($input: ProductInput!) {
  productCreate(input: $input) {
    product {
      id
      title
      handle
      tags
      variants(first: 10) {
        nodes { id sku inventoryItem { id } }
      }
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
    media {
      id
      status
      preview { image { url } }
    }
    mediaUserErrors { field message code }
  }
}
`;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // 1) Verify Firebase ID token
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });

    const decoded = await adminAuth.verifyIdToken(token);
    const merchantId = decoded.uid;

    // 2) Validate body
    const { title, description, price, currency = "INR", tags = [], resourceUrls = [] } = req.body || {};
    if (!title || !price) return res.status(400).json({ ok: false, error: "title and price are required" });

    const merchantProductId = `mp_${nanoid(10)}`; // our SKU
    const shopifyTags = [...new Set([`merchant:${merchantId}`, ...tags])];

    // 3) Create product without images first
    const createRes = await shopifyGraphQL(PRODUCT_CREATE, {
      input: {
        title,
        bodyHtml: description || "",
        vendor: "DRIPPR Marketplace",
        tags: shopifyTags,
        variants: [{ price: String(price), sku: merchantProductId }],
      },
    });

    const product = createRes.data.productCreate.product;
    const variant = product.variants.nodes[0];

    // 4) Metafields for mapping
    await shopifyGraphQL(METAFIELDS_SET, {
      metafields: [
        {
          ownerId: product.id,
          namespace: "marketplace",
          key: "merchant_id",
          type: "single_line_text_field",
          value: merchantId,
        },
        {
          ownerId: product.id,
          namespace: "marketplace",
          key: "merchant_product_id",
          type: "single_line_text_field",
          value: merchantProductId,
        },
      ],
    });

    // 5) Attach images via productCreateMedia if any staged uploads provided
    if (Array.isArray(resourceUrls) && resourceUrls.length) {
      const media = resourceUrls.slice(0, 10).map((url: string) => ({
        originalSource: url,     // from stagedUploadsCreate.target.resourceUrl
        mediaContentType: "IMAGE",
      }));

      const mediaRes = await shopifyGraphQL(PRODUCT_CREATE_MEDIA, {
        productId: product.id,
        media,
      });

      if (mediaRes.data.productCreateMedia.mediaUserErrors?.length) {
        console.warn("mediaUserErrors", mediaRes.data.productCreateMedia.mediaUserErrors);
      }
    }

    // 6) Mirror to Firestore
    const now = Date.now();
    const docRef = adminDb.collection("merchantProducts").doc();
    await docRef.set({
      id: docRef.id,
      merchantId,
      title,
      description: description || "",
      price: Number(price),
      currency,
      status: "active",
      sku: merchantProductId,
      shopifyProductId: product.id,
      shopifyVariantIds: [variant.id],
      tags: shopifyTags,
      imageUrls: resourceUrls || [],
      inventoryQty: null,
      createdAt: now,
      updatedAt: now,
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
