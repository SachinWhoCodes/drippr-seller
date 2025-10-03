import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

type MerchantDoc = {
  uid: string;
  email?: string;
  name?: string;
  phone?: string;
  createdAt?: number; // ms
  storeName?: string;
  businessCategory?: string;
  gstin?: string;
  address?: string;
};

export default function Settings() {
  // Auth
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [authEmail, setAuthEmail] = useState<string | null>(auth.currentUser?.email ?? null);
  const joinDateText = useMemo(() => {
    // prefer Auth createdAt if available
    const createdAt = auth.currentUser?.metadata?.creationTime
      ? new Date(auth.currentUser.metadata.creationTime).toLocaleDateString()
      : null;
    return createdAt ?? "";
  }, [uid]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUid(u?.uid ?? null);
      setAuthEmail(u?.email ?? null);
    });
    return () => unsub();
  }, []);

  // Live Merchant doc
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [merchant, setMerchant] = useState<MerchantDoc | null>(null);

  useEffect(() => {
    if (!uid) return;
    const ref = doc(db, "merchants", uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const data = (snap.data() as MerchantDoc | undefined) || null;
        setMerchant(data);
        setLoadingDoc(false);
        // hydrate forms if empty
        if (data && !dirtyProfile) {
          setName(data.name || "");
          setPhone(data.phone || "");
        }
        if (data && !dirtyStore) {
          setStoreName(data.storeName || "");
          setBusinessCategory(data.businessCategory || "");
          setGstin(data.gstin || "");
          setAddress(data.address || "");
        }
      },
      () => setLoadingDoc(false)
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // ---------- Profile form ----------
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // flags so we don't overwrite user typing when snapshot arrives
  const [dirtyProfile, setDirtyProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uid) return toast.error("Please sign in again.");

    try {
      setSavingProfile(true);
      const ref = doc(db, "merchants", uid);
      await setDoc(
        ref,
        {
          uid,
          email: authEmail ?? merchant?.email ?? null,
          name: name.trim(),
          phone: phone.trim(),
          updatedAt: Date.now(),
          // set createdAt if doc is new
          ...(merchant ? {} : { createdAt: Date.now() }),
        },
        { merge: true }
      );
      toast.success("Profile updated successfully!");
      setDirtyProfile(false);
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Failed to update profile");
    } finally {
      setSavingProfile(false);
    }
  };

  // ---------- Store form ----------
  const [storeName, setStoreName] = useState("");
  const [businessCategory, setBusinessCategory] = useState("");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [dirtyStore, setDirtyStore] = useState(false);
  const [savingStore, setSavingStore] = useState(false);

  const handleSaveStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uid) return toast.error("Please sign in again.");
    try {
      setSavingStore(true);
      const ref = doc(db, "merchants", uid);
      await setDoc(
        ref,
        {
          uid,
          storeName: storeName.trim() || null,
          businessCategory: businessCategory.trim() || null,
          gstin: gstin.trim() || null,
          address: address.trim() || null,
          updatedAt: Date.now(),
          ...(merchant ? {} : { createdAt: Date.now(), email: authEmail ?? null }),
        },
        { merge: true }
      );
      toast.success("Store details updated successfully!");
      setDirtyStore(false);
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Failed to update store details");
    } finally {
      setSavingStore(false);
    }
  };

  // ---------- Change password ----------
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changingPw, setChangingPw] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user || !authEmail) return toast.error("Please sign in again.");
    if (newPw.length < 6) return toast.error("New password must be at least 6 characters.");
    if (newPw !== confirmPw) return toast.error("New passwords do not match.");

    try {
      setChangingPw(true);
      // Re-authenticate with current password
      const cred = EmailAuthProvider.credential(authEmail, currentPw);
      await reauthenticateWithCredential(user, cred);
      // Update password
      await updatePassword(user, newPw);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      toast.success("Password changed successfully!");
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.code === "auth/wrong-password"
          ? "Current password is incorrect."
          : err?.code === "auth/too-many-requests"
          ? "Too many attempts. Please try again later."
          : err?.message || "Failed to change password";
      toast.error(msg);
    } finally {
      setChangingPw(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
          <p className="text-muted-foreground">Manage your account and store settings</p>
        </div>

        <Tabs defaultValue="profile" className="space-y-6">
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="store">Store Details</TabsTrigger>
            <TabsTrigger value="password">Password</TabsTrigger>
          </TabsList>

          {/* Profile Tab */}
          <TabsContent value="profile">
            <Card>
              <CardHeader>
                <CardTitle>Personal Information</CardTitle>
                <CardDescription>Update your personal details</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveProfile} className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Full Name</Label>
                      <Input
                        id="name"
                        placeholder="Enter your name"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setDirtyProfile(true);
                        }}
                        disabled={!uid || loadingDoc || savingProfile}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={authEmail || ""}
                        disabled
                      />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="phone">Phone</Label>
                      <Input
                        id="phone"
                        placeholder="+91 98765 43210"
                        value={phone}
                        onChange={(e) => {
                          setPhone(e.target.value);
                          setDirtyProfile(true);
                        }}
                        disabled={!uid || loadingDoc || savingProfile}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="joinDate">Member Since</Label>
                      <Input id="joinDate" value={joinDateText} disabled />
                    </div>
                  </div>

                  <Button type="submit" disabled={!uid || savingProfile}>
                    {savingProfile ? "Saving…" : "Save Changes"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Store Tab */}
          <TabsContent value="store">
            <Card>
              <CardHeader>
                <CardTitle>Store Information</CardTitle>
                <CardDescription>Manage your store details</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveStore} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="storeName">Store Name</Label>
                    <Input
                      id="storeName"
                      placeholder="Enter store name"
                      value={storeName}
                      onChange={(e) => {
                        setStoreName(e.target.value);
                        setDirtyStore(true);
                      }}
                      disabled={!uid || loadingDoc || savingStore}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="category">Business Category</Label>
                    <Input
                      id="category"
                      placeholder="e.g., Fashion & Electronics"
                      value={businessCategory}
                      onChange={(e) => {
                        setBusinessCategory(e.target.value);
                        setDirtyStore(true);
                      }}
                      disabled={!uid || loadingDoc || savingStore}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="gstin">GSTIN</Label>
                    <Input
                      id="gstin"
                      placeholder="Enter GSTIN"
                      value={gstin}
                      onChange={(e) => {
                        setGstin(e.target.value);
                        setDirtyStore(true);
                      }}
                      disabled={!uid || loadingDoc || savingStore}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="address">Business Address</Label>
                    <Textarea
                      id="address"
                      placeholder="Enter complete address"
                      className="min-h-24"
                      value={address}
                      onChange={(e) => {
                        setAddress(e.target.value);
                        setDirtyStore(true);
                      }}
                      disabled={!uid || loadingDoc || savingStore}
                    />
                  </div>

                  <Button type="submit" disabled={!uid || savingStore}>
                    {savingStore ? "Saving…" : "Save Changes"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Password Tab */}
          <TabsContent value="password">
            <Card>
              <CardHeader>
                <CardTitle>Change Password</CardTitle>
                <CardDescription>Update your account password</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleChangePassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="currentPassword">Current Password</Label>
                    <Input
                      id="currentPassword"
                      type="password"
                      placeholder="Enter current password"
                      value={currentPw}
                      onChange={(e) => setCurrentPw(e.target.value)}
                      required
                      disabled={!uid || changingPw}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="newPassword">New Password</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      placeholder="Enter new password"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      required
                      disabled={!uid || changingPw}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm New Password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      placeholder="Re-enter new password"
                      value={confirmPw}
                      onChange={(e) => setConfirmPw(e.target.value)}
                      required
                      disabled={!uid || changingPw}
                    />
                  </div>

                  <Button type="submit" disabled={!uid || changingPw}>
                    {changingPw ? "Changing…" : "Change Password"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
