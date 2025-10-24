// api/admin/queue/list.ts
import { getAdmin } from "../../_lib/firebaseAdmin.js";

type Decoded = { uid: string; email?: string; isAdmin?: boolean; admin?: boolean; role?: string };

async function requireAdmin(decoded: Decoded, adminDb: FirebaseFirestore.Firestore) {
  if (decoded?.isAdmin || decoded?.admin || decoded?.role === "admin") return;
  const doc = await adminDb.collection("admins").doc(decoded.uid).get();
  if (doc.exists && doc.get("enabled") !== false) return;
  throw new Error("not_admin");
}

function pick<T extends Record<string, any>>(obj: T, keys: string[]) {
  const out: Record<string, any> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminAuth, adminDb } = getAdmin();

    // auth
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    const decoded = (await adminAuth.verifyIdToken(token)) as Decoded;

    await requireAdmin(decoded, adminDb);

    // query params
    const url = new URL(req.url, "http://localhost");
    const statusParam = String((req.query?.status ?? url.searchParams.get("status") ?? "in_review") || "");
    const qParam = String((req.query?.q ?? url.searchParams.get("q") ?? "") || "").trim().toLowerCase();

    // Firestore query
    let ref: FirebaseFirestore.Query = adminDb.collection("merchantProducts");
    let needLocalSort = false;

    if (statusParam === "in_review") {
      ref = ref.where("status", "==", "in_review");
    } else if (statusParam === "draft") {
      ref = ref.where("status", "==", "draft");
    } else {
      // all statuses
      // Try ordering by createdAt for recency
      ref = ref.orderBy("createdAt", "desc");
    }

    // limits
    if (statusParam === "all") {
      ref = ref.limit(300);
    } else {
      // to avoid composite index needs (status + orderBy), skip orderBy and sort in memory
      needLocalSort = true;
      ref = ref.limit(500);
    }

    const snap = await ref.get();
    let items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

    if (needLocalSort) {
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    // Enrich with merchant profile (name/email)
    const merchantIds = Array.from(new Set(items.map((i) => i.merchantId).filter(Boolean)));
    const merchantMap = new Map<string, any>();
    await Promise.all(
      merchantIds.map(async (mid) => {
        const m = await adminDb.collection("merchants").doc(mid).get();
        if (m.exists) merchantMap.set(mid, m.data());
      })
    );

    const enriched = items.map((p) => ({
      ...p,
      merchant: p.merchantId
        ? pick(merchantMap.get(p.merchantId) || { uid: p.merchantId }, ["uid", "name", "email"])
        : undefined,
    }));

    // simple text search (title or merchant name/email)
    const filtered = qParam
      ? enriched.filter((p) => {
          const hay =
            `${p.title || ""} ${p.merchant?.name || ""} ${p.merchant?.email || ""}`.toLowerCase();
          return hay.includes(qParam);
        })
      : enriched;

    return res.status(200).json({ ok: true, items: filtered });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg === "not_admin") return res.status(403).json({ ok: false, error: "Admin only" });
    console.error("queue/list error:", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
}