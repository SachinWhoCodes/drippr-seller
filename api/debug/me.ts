// api/admin/debug/me.ts
import { getAdmin } from "../_lib/firebaseAdmin.js";

/**
 * Verifies the caller's Firebase ID token and checks ADMIN_UIDS.
 * Helps confirm auth + env + admin gating are wired correctly.
 */
export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const { adminAuth } = getAdmin();
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });

    const decoded = await adminAuth.verifyIdToken(token);

    const adminUids = (process.env.ADMIN_UIDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const isAdmin = adminUids.includes(decoded.uid);

    return res.status(200).json({
      ok: true,
      uid: decoded.uid,
      email: decoded.email || null,
      isAdmin,
      adminUids,
      project: process.env.FIREBASE_PROJECT_ID || null,
      envOk: Boolean(process.env.ADMIN_UIDS),
    });
  } catch (e: any) {
    console.error("debug/me error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
}
