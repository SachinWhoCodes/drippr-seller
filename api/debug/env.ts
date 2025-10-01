export default function handler(req: any, res: any) {
  res.status(200).json({
    ok: true,
    has: {
      SHOPIFY_STORE_DOMAIN: !!process.env.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_ADMIN_TOKEN: !!process.env.SHOPIFY_ADMIN_TOKEN,
      SHOPIFY_API_VERSION: !!process.env.SHOPIFY_API_VERSION,
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
    },
  });
}
