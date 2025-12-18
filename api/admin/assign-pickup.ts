// api/admin/assign-pickup.ts
import { getAdmin } from "../_lib/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function toStr(v: any, max = 500): string {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function isValidPhone(p: string) {
  // simple, non-restrictive (supports +91 etc.)
  return !p || /^[0-9+\-\s()]{6,20}$/.test(p);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { adminDb } = getAdmin();

    // --- Auth (admin only) ---
    const authHeader = String(req.headers.authorization || "");
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const idToken = match?.[1];
    if (!idToken) return res.status(401).json({ ok: false, error: "Missing Authorization Bearer token" });

    let uid = "";
    let isAdmin = false;
    try {
      const decoded: any = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
      isAdmin = decoded.admin === true || decoded.isAdmin === true || decoded.role === "admin";
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    if (!isAdmin) return res.status(403).json({ ok: false, error: "Admin only" });

    const body = req.body || {};
    const orderId = toStr(body.orderId, 200);
    if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    // Pickup plan
    const pickupWindow = toStr(body.pickupWindow, 200);     // e.g. "Today 4-6 PM"
    const pickupAddress = toStr(body.pickupAddress, 600);   // vendor pickup address
    const pickupNotes = toStr(body.notes, 800);

    // Delivery partner
    const partnerName = toStr(body.deliveryPartner?.name, 120);
    const partnerPhone = toStr(body.deliveryPartner?.phone, 40);
    const etaText = toStr(body.deliveryPartner?.etaText, 120);           // e.g. "Arriving in 45 min"
    const trackingUrl = toStr(body.deliveryPartner?.trackingUrl, 400);   // optional

    if (partnerPhone && !isValidPhone(partnerPhone)) {
      return res.status(400).json({ ok: false, error: "Invalid delivery partner phone format" });
    }

    const now = Date.now();
    const THIRTY_MIN = 30 * 60 * 1000;

    const orderRef = adminDb.collection("orders").doc(orderId);
    let out: any = null;

    await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) {
        out = { ok: false, status: 404, error: "Order not found" };
        return;
      }

      const o = snap.data() as any;

      const workflowStatus = String(o.workflowStatus || "vendor_pending");

      // Idempotent success if already assigned (or later)
      if (workflowStatus === "pickup_assigned" || workflowStatus === "dispatched") {
        out = {
          ok: true,
          alreadyAssigned: true,
          workflowStatus,
          pickupPlan: o.pickupPlan || null,
          deliveryPartner: o.deliveryPartner || null,
          adminPlannedAt: o.adminPlannedAt || null,
        };
        return;
      }

      if (workflowStatus !== "vendor_accepted" && workflowStatus !== "admin_overdue") {
        out = { ok: false, status: 409, error: `Cannot assign pickup from state: ${workflowStatus}` };
        return;
      }

      const acceptedAt = Number(o.vendorAcceptedAt || 0);
      if (!acceptedAt) {
        out = { ok: false, status: 409, error: "Missing vendorAcceptedAt (vendor must accept first)" };
        return;
      }

      // Compute/ensure adminPlanBy (deadline)
      const adminPlanBy = Number(o.adminPlanBy || (acceptedAt + THIRTY_MIN));
      const overdue = now > adminPlanBy;

      const pickupPlanObj =
        pickupWindow || pickupAddress || pickupNotes
          ? {
              pickupWindow: pickupWindow || null,
              pickupAddress: pickupAddress || null,
              notes: pickupNotes || null,
            }
          : null;

      const partnerObj =
        partnerName || partnerPhone || etaText || trackingUrl
          ? {
              name: partnerName || null,
              phone: partnerPhone || null,
              etaText: etaText || null,
              trackingUrl: trackingUrl || null,
            }
          : null;

      // Save assignment
      tx.set(
        orderRef,
        {
          updatedAt: now,

          // Always move to pickup_assigned (even if overdue)
          workflowStatus: "pickup_assigned",
          adminPlannedAt: now,
          adminPlanBy,

          pickupPlan: pickupPlanObj,
          deliveryPartner: partnerObj,

          pickupAssignedBy: uid,

          workflowTimeline: FieldValue.arrayUnion(
            ...(overdue
              ? [
                  {
                    at: now,
                    type: "admin_overdue",
                    note: "Admin planning completed after 30-minute window",
                  },
                ]
              : []),
            {
              at: now,
              type: "pickup_assigned",
              note: "Pickup planned and delivery partner assigned",
            }
          ),
        },
        { merge: true }
      );

      out = {
        ok: true,
        workflowStatus: "pickup_assigned",
        overdue,
        adminPlanBy,
        adminPlannedAt: now,
        pickupPlan: pickupPlanObj,
        deliveryPartner: partnerObj,
      };
    });

    if (!out) return res.status(500).json({ ok: false, error: "Unknown error" });
    if (out.ok === false) return res.status(out.status || 400).json(out);

    return res.status(200).json(out);
  } catch (err: any) {
    console.error("admin/assign-pickup error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

