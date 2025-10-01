import { getAdmin } from "../_lib/firebaseAdmin.js";

export default function handler(req: any, res: any) {
  try {
    const { adminAuth, adminDb } = getAdmin();
    res.status(200).json({
      ok: true,
      authReady: !!adminAuth,
      dbReady: !!adminDb,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
