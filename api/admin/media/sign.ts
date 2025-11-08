// api/admin/media/sign.ts
import ImageKit from "imagekit";
import { getAdmin } from "../../_lib/firebaseAdmin.js";

// Init once per Lambda
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
});

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { adminAuth } = getAdmin();

  try {
    // --- Auth like your other admin endpoints ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      return res.status(401).json({ ok: false, error: "Missing Authorization" });
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;

    // Optional: allow client to suggest a folder, or default per-user
    const body = req.body || {};
    const folder = body.folder || `/media/${uid}`;

    // ImageKit auth params for client upload
    const authParams = imagekit.getAuthenticationParameters();

    return res.status(200).json({
      ok: true,
      ...authParams, // { token, expire, signature }
      publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
      urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
      folder,
      uid,
    });
  } catch (err: any) {
    console.error("media/sign error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
}