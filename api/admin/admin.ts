// api/admin.ts
import { getAdmin } from "../_lib/firebaseAdmin.js";

// Helpers
function requireMethod(req: any, res: any, methods: string[]) {
  if (!methods.includes(req.method)) {
    res.setHeader("Allow", methods.join(", "));
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return false;
  }
  return true;
}

async function requireAdmin(req: any, res: any) {
  const { adminAuth } = getAdmin();
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    res.status(401).json({ ok: false, error: "Missing Authorization" });
    return null;
  }
  const decoded = await adminAuth.verifyIdToken(token);
  const adminUids = (process.env.ADMIN_UIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!adminUids.includes(decoded.uid)) {
    res.status(403).json({ ok: false, error: "Admins only" });
    return null;
  }
  return decoded;
}

export default async function handler(req: any, res: any) {
  try {

    // --- ADD THIS BLOCK ---
    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(200).end();
    }
    // --- END OF BLOCK ---

    if (!requireMethod(req, res, ["GET", "POST"])) return;

    // Parse input
    const body = req.method === "POST" ? (req.body ?? {}) : {};
    const action = (req.query.action as string) || body.action || "";
    if (!action) return res.status(400).json({ ok: false, error: "Missing action" });

    const me = await requireAdmin(req, res);
    if (!me) return;

    const { adminDb } = getAdmin();

    // ---------- ACTIONS ----------
    switch (action) {
      // -------------------- MERCHANTS --------------------
      case "merchants.list": {
        // optional search "q"
        const q = String((req.query.q ?? body.q ?? "") as string).toLowerCase().trim();
        // fetch up to 500 and filter in-memory to avoid composite index churn
        const snap = await adminDb.collection("merchants").limit(500).get();
        const items = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as any) }));
        const filtered = q
          ? items.filter((m) =>
              `${m.name ?? ""} ${m.email ?? ""} ${m.storeName ?? ""}`.toLowerCase().includes(q)
            )
          : items;
        // normalize boolean enabled (default true)
        filtered.forEach((m) => {
          if (typeof m.enabled !== "boolean") m.enabled = true;
        });
        return res.status(200).json({ ok: true, items: filtered });
      }

      case "merchants.update": {
        const { uid, patch } = body as { uid: string; patch: Record<string, any> };
        if (!uid || !patch) return res.status(400).json({ ok: false, error: "uid & patch required" });
        await adminDb.collection("merchants").doc(uid).set(
          {
            ...patch,
            updatedAt: Date.now(),
          },
          { merge: true },
        );
        return res.status(200).json({ ok: true });
      }

      // -------------------- PRODUCT QUEUE --------------------
      // We assume sellers write docs in `productQueue` at create-time (see patch for create.ts below).
      case "queue.list": {
        const status = String((req.query.status ?? body.status ?? "pending") as string);
        const limit = Number(req.query.limit ?? body.limit ?? 200);
        let ref = adminDb.collection("productQueue") as FirebaseFirestore.Query;

        if (status && status !== "all") ref = ref.where("status", "==", status);
        // order by createdAt desc when available
        ref = ref.limit(limit);

        const snap = await ref.get();
        let items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

        // best-effort local sort if missing index
        items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        // enrich with merchant profile (name/email)
        const merchantIds = Array.from(new Set(items.map((i) => i.merchantId).filter(Boolean)));
        const merchantMap = new Map<string, any>();
        await Promise.all(
          merchantIds.map(async (mid) => {
            const m = await adminDb.collection("merchants").doc(mid).get();
            if (m.exists) merchantMap.set(mid, m.data());
          })
        );
        const enriched = items.map((i) => ({
          ...i,
          merchant: merchantMap.get(i.merchantId) || null,
        }));

        return res.status(200).json({ ok: true, items: enriched });
      }

      case "queue.approve": {
        const { id, note } = body as { id: string; note?: string };
        if (!id) return res.status(400).json({ ok: false, error: "id required" });

        const ref = adminDb.collection("productQueue").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "queue item not found" });

        const qdoc = snap.data() as any;

        await ref.set(
          {
            status: "approved",
            reviewerUid: me.uid,
            reviewNote: note || null,
            reviewedAt: Date.now(),
            updatedAt: Date.now(),
          },
          { merge: true }
        );

        // Optional: flip merchantProducts status to 'active' if linked
        if (qdoc.merchantProductDocId) {
          await adminDb.collection("merchantProducts").doc(qdoc.merchantProductDocId).set(
            { status: "active", updatedAt: Date.now() },
            { merge: true }
          );
        }

        return res.status(200).json({ ok: true });
      }

      case "queue.reject": {
        const { id, reason } = body as { id: string; reason?: string };
        if (!id) return res.status(400).json({ ok: false, error: "id required" });

        const ref = adminDb.collection("productQueue").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "queue item not found" });

        await ref.set(
          {
            status: "rejected",
            reviewerUid: me.uid,
            reviewNote: reason || null,
            reviewedAt: Date.now(),
            updatedAt: Date.now(),
          },
          { merge: true }
        );

        return res.status(200).json({ ok: true });
      }

      // -------------------- SUPPORT CENTER (optional, nice to have here too) --------------------
      case "support.list": {
        const status = String((req.query.status ?? body.status ?? "all") as string);
        let ref = adminDb.collection("supportRequests") as FirebaseFirestore.Query;
        if (status !== "all") ref = ref.where("status", "==", status);
        const snap = await ref.orderBy("createdAt", "desc").limit(200).get();
        const items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        return res.status(200).json({ ok: true, items });
      }

      case "support.reply": {
        const { id, message, nextStatus } = body as { id: string; message: string; nextStatus?: string };
        if (!id || !message) return res.status(400).json({ ok: false, error: "id & message required" });

        await adminDb.collection("supportRequests").doc(id).set(
          {
            adminReply: message,
            status: nextStatus || "under_processing",
            repliedAt: Date.now(),
            repliedBy: me.uid,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }
  } catch (e: any) {
    console.error("admin gateway error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
}
