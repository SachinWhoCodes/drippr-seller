import { getAdmin } from "../_lib/firebaseAdmin.js";

export default async function handler(req: any, res: any) {
  try {
    const { adminDb } = getAdmin();
    const ref = adminDb.collection("debugWrites").doc();
    await ref.set({ ts: Date.now() });
    res.status(200).json({ ok: true, docId: ref.id });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
