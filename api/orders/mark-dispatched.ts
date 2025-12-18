// api/orders/mark-dispatched.ts
import { getAdmin } from "../_lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminDb } = getAdmin();

    // --- Auth: require Firebase ID token ---
    const authHeader = String(req.headers.authorization || "");
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const idToken = match?.[1];
    if (!idToken) return res.status(401).json({ ok: false, error: "Missing Authorization Bearer token" });

    let uid = "";
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    const body = req.body || {};
    const orderId = String(body.orderId || "").trim();
    if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    const now = Date.now();
    const orderRef = adminDb.collection("orders").doc(orderId);

    let out: any = null;

    await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) {
        out = { ok: false, status: 404, error: "Order not found" };
        return;
      }

      const o = snap.data() as any;
      const merchantId = String(o.merchantId || "");

      // Security: only merchant owner can dispatch
      if (!merchantId || merchantId !== uid) {
        out = { ok: false, status: 403, error: "Forbidden" };
        return;
      }

      const workflowStatus = String(o.workflowStatus || "vendor_pending");

      // Idempotent success
      if (workflowStatus === "dispatched") {
        out = {
          ok: true,
          alreadyDispatched: true,
          workflowStatus: "dispatched",
          dispatchedAt: o.dispatchedAt || null,
        };
        return;
      }

      // Only after pickup assigned
      if (workflowStatus !== "pickup_assigned") {
        out = { ok: false, status: 409, error: `Cannot dispatch from state: ${workflowStatus}` };
        return;
      }

      tx.set(
        orderRef,
        {
          updatedAt: now,
          workflowStatus: "dispatched",
          dispatchedAt: now,
          workflowTimeline: FieldValue.arrayUnion({
            at: now,
            type: "dispatched",
            note: "Vendor marked order as dispatched",
          }),
        },
        { merge: true }
      );

      out = { ok: true, workflowStatus: "dispatched", dispatchedAt: now };
    });

    if (!out) return res.status(500).json({ ok: false, error: "Unknown error" });
    if (out.ok === false) return res.status(out.status || 400).json(out);

    return res.status(200).json(out);
  } catch (err: any) {
    console.error("orders/mark-dispatched error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

