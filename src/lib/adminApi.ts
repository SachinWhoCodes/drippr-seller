// --- Admin check hook (Firestore-based) ---
import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

/**
 * Returns true if the current user has an enabled admin record at:
 *   admins/{uid} with { enabled: true }
 * Falls back to false if signed out or document missing/disabled.
 */
export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let unsubAdmin: (() => void) | undefined;

    const unsubAuth = onAuthStateChanged(auth, (u) => {
      // clear previous listener
      if (unsubAdmin) {
        unsubAdmin();
        unsubAdmin = undefined;
      }
      if (!u) {
        setIsAdmin(false);
        return;
      }
      const ref = doc(db, "admins", u.uid);
      unsubAdmin = onSnapshot(
        ref,
        (snap) => setIsAdmin(snap.exists() && snap.get("enabled") !== false),
        () => setIsAdmin(false)
      );
    });

    return () => {
      unsubAuth();
      if (unsubAdmin) unsubAdmin();
    };
  }, []);

  return isAdmin;
}


// --- Publication (Sales Channel) helpers ---

/**
 * Returns the Shopify Publication (sales channel) GraphQL ID to use when
 * publishing products, or null if not configured.
 *
 * Set this in your env as VITE_SHOPIFY_PUBLICATION_ID, e.g.:
 * gid://shopify/Publication/1234567890
 */
export function getLocalPublicationId(): string | null {
  // Vite-style env vars:
  const id =
    (import.meta as any)?.env?.VITE_SHOPIFY_PUBLICATION_ID ??
    (import.meta as any)?.env?.VITE_PUBLICATION_ID ??
    "";

  const trimmed = String(id || "").trim();
  return trimmed ? trimmed : null;
}



async function call(action: string, payload: any = {}) {
  const u = auth.currentUser;
  if (!u) throw new Error("Not signed in");
  const idToken = await u.getIdToken(true);

  const r = await fetch("/api/admin?action=" + encodeURIComponent(action), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) {
    throw new Error(j?.error || `Admin call failed: ${action}`);
  }
  return j;
}

// ---------- exported APIs used by your pages ----------
export const listMerchants = (params: { q?: string } = {}) =>
  call("merchants.list", params);

export const updateMerchant = (uid: string, patch: Record<string, any>) =>
  call("merchants.update", { uid, patch });

export const queueList = (params: { status?: string; limit?: number } = {}) =>
  call("queue.list", params);

export const queueApprove = (id: string, note?: string) =>
  call("queue.approve", { id, note });

export const queueReject = (id: string, reason?: string) =>
  call("queue.reject", { id, reason });

export const supportList = (params: { status?: string } = {}) =>
  call("support.list", params);

export const supportReply = (id: string, message: string, nextStatus?: string) =>
  call("support.reply", { id, message, nextStatus });
