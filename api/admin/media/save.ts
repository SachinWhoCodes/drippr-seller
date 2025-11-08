// api/admin/media/save.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { adminAuth, adminDb } = getAdmin();

  try {
    // --- Auth (same pattern) ---
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      return res.status(401).json({ ok: false, error: "Missing Authorization" });
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;

    const body = req.body || {};
    const {
      url,
      fileId,
      name,
      size,
      width,
      height,
      mime,
      folder,
      thumbnailUrl,
    } = body;

    if (!url || !fileId) {
      return res.status(400).json({ ok: false, error: "Missing url or fileId" });
    }

    const now = Date.now();
    const docRef = await adminDb.collection("merchantMedia").add({
      merchantId: uid,
      url,
      fileId,
      name: name || null,
      size: size ?? null,
      width: width ?? null,
      height: height ?? null,
      mime: mime || null,
      folder: folder || null,
      thumbnailUrl: thumbnailUrl || null,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(200).json({ ok: true, id: docRef.id });
  } catch (err: any) {
    console.error("media/save error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
}