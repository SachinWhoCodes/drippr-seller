// --- Admin check hook (Firestore-based) ---
import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot } from "firebase/firestore";


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


let _publicationIdCache: string | null | undefined; // undefined => not fetched yet

/**
 * One-time fetch of the Shopify Publication (sales channel) GraphQL ID
 * from Firestore: adminSettings/shopify.publicationId
 */
export async function getPublicationId(): Promise<string | null> {
  if (_publicationIdCache !== undefined) return _publicationIdCache ?? null;

  const ref = doc(db, "adminSettings", "shopify");
  const snap = await getDoc(ref);
  const val = (snap.exists() ? (snap.data().publicationId as string | null | undefined) : null) ?? null;

  _publicationIdCache = val;
  return val;
}

/**
 * Realtime listener (optional) if your UI should update live.
 * Returns unsubscribe() like any Firestore onSnapshot.
 */
export function watchPublicationId(cb: (id: string | null) => void) {
  const ref = doc(db, "adminSettings", "shopify");
  return onSnapshot(ref, (snap) => {
    const val = (snap.exists() ? (snap.data().publicationId as string | null | undefined) : null) ?? null;
    _publicationIdCache = val;
    cb(val);
  });
}

/**
 * Write the Publication ID (admins only).
 * Saves admin uid + timestamp for audit.
 */
export async function setPublicationId(id: string | null): Promise<void> {
  const uid = auth.currentUser?.uid ?? null;
  const ref = doc(db, "adminSettings", "shopify");

  await setDoc(
    ref,
    {
      publicationId: (id ?? "").trim() || null,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    },
    { merge: true }
  );

  _publicationIdCache = (id ?? "").trim() || null;
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
