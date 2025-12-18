// api/orders/accept.ts
import { getAdmin } from "../_lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// If you're on Next.js pages/api, keep this (JSON body parsing ON by default).
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // Ensure Admin SDK is initialized
    const { adminDb } = getAdmin();

    // --- Auth: require Firebase ID token ---
    const authHeader = String(req.headers.authorization || "");
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const idToken = match?.[1];

    if (!idToken) {
      return res.status(401).json({ ok: false, error: "Missing Authorization Bearer token" });
    }

    let uid: string;
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    const body = req.body || {};
    const orderId = String(body.orderId || "").trim(); // Firestore doc id: `${shopifyOrderId}_${merchantId}`
    if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    const now = Date.now();
    const THIRTY_MIN = 30 * 60 * 1000;
    const THREE_HOURS = 3 * 60 * 60 * 1000;

    const orderRef = adminDb.collection("orders").doc(orderId);

    let out: any = null;

    await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) {
        out = { ok: false, status: 404, error: "Order not found" };
        return;
      }

      const o = snap.data() as any;

      // Security: only the merchant who owns this order doc can accept it
      const merchantId = String(o.merchantId || "");
      if (!merchantId || merchantId !== uid) {
        out = { ok: false, status: 403, error: "Forbidden" };
        return;
      }

      // Determine current workflow status
      const workflowStatus = String(o.workflowStatus || "vendor_pending");

      // If already accepted (idempotent success)
      if (workflowStatus === "vendor_accepted" || workflowStatus === "pickup_assigned" || workflowStatus === "dispatched") {
        out = {
          ok: true,
          alreadyAccepted: true,
          workflowStatus,
          vendorAcceptedAt: o.vendorAcceptedAt || null,
          adminPlanBy: o.adminPlanBy || null,
          invoice: o.invoice || null,
        };
        return;
      }

      if (workflowStatus !== "vendor_pending") {
        out = { ok: false, status: 409, error: `Cannot accept from state: ${workflowStatus}` };
        return;
      }

      // Enforce 3-hour deadline
      const createdAt = Number(o.createdAt || 0) || now;
      const acceptBy = Number(o.vendorAcceptBy || (createdAt + THREE_HOURS));
      if (now > acceptBy) {
        // Mark expired (optional but helpful)
        tx.set(
          orderRef,
          {
            workflowStatus: "vendor_expired",
            updatedAt: now,
            workflowTimeline: FieldValue.arrayUnion({
              at: now,
              type: "vendor_expired",
              note: "Vendor did not accept within 3 hours",
            }),
          },
          { merge: true }
        );

        out = { ok: false, status: 410, error: "Acceptance window expired" };
        return;
      }

      // Prepare invoice link (generated on-demand by another API we will add next)
      const invoiceUrl = `/api/orders/invoice?orderId=${encodeURIComponent(orderId)}`;

      tx.set(
        orderRef,
        {
          updatedAt: now,

          // ✅ workflow transition
          workflowStatus: "vendor_accepted",
          vendorAcceptedAt: now,
          adminPlanBy: now + THIRTY_MIN,

          // ✅ invoice becomes available after acceptance
          invoice: {
            status: "ready",
            url: invoiceUrl,
            generatedAt: now,
          },

          workflowTimeline: FieldValue.arrayUnion(
            {
              at: now,
              type: "vendor_accepted",
              note: "Vendor accepted the order",
            },
            {
              at: now,
              type: "invoice_ready",
              note: "Billing slip is available to download",
            }
          ),
        },
        { merge: true }
      );

      out = {
        ok: true,
        workflowStatus: "vendor_accepted",
        vendorAcceptedAt: now,
        adminPlanBy: now + THIRTY_MIN,
        invoice: { status: "ready", url: invoiceUrl, generatedAt: now },
      };
    });

    if (!out) return res.status(500).json({ ok: false, error: "Unknown error" });
    if (out.ok === false) return res.status(out.status || 400).json(out);

    return res.status(200).json(out);
  } catch (err: any) {
    console.error("orders/accept error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

