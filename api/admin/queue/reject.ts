// api/admin/queue/reject.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";

type Decoded = { uid: string; email?: string; isAdmin?: boolean; admin?: boolean; role?: string };

async function requireAdmin(decoded: Decoded, adminDb: FirebaseFirestore.Firestore) {
  if (decoded?.isAdmin || decoded?.admin || decoded?.role === "admin") return;
  const doc = await adminDb.collection("admins").doc(decoded.uid).get();
  if (doc.exists && doc.get("enabled") !== false) return;
  throw new Error("not_admin");
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminAuth, adminDb } = getAdmin();

    // auth
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = (await adminAuth.verifyIdToken(token)) as Decoded;

    await requireAdmin(decoded, adminDb);

    const { id, reason } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "Missing product id" });
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ ok: false, error: "Missing rejection reason" });
    }

    const docRef = adminDb.collection("merchantProducts").doc(String(id));
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Not found" });

    await docRef.set(
      {
        status: "rejected",
        rejectReason: String(reason).trim(),
        rejectedAt: Date.now(),
        rejectedBy: { uid: decoded.uid, email: decoded.email || null },
        // clear previous approval flags if any
        approvedAt: null,
        approvedBy: null,
      },
      { merge: true }
    );

    // (Optional) notify seller via inbox/notifications collection here

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg === "not_admin") return res.status(403).json({ ok: false, error: "Admin only" });
    console.error("queue/reject error:", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
}