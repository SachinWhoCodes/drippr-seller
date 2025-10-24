import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Edit, Trash2, X, Upload } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";

type StagedTarget = {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
};

type MerchantProduct = {
  id: string;
  title: string;
  price?: number;
  productType?: string;
  status?: "pending" | "approved" | "rejected";
  images?: string[];
  image?: string;
  createdAt?: number;
  sku?: string;
  stock?: number;
};

type VariantOption = { name: string; values: string[] };
type VariantRow = {
  id: string;
  options: string[];     // [opt1Val, opt2Val?, opt3Val?]
  title: string;         // "Red / M / Cotton"
  price?: number;
  compareAtPrice?: number;
  sku?: string;
  quantity?: number;
  barcode?: string;
  weightGrams?: number;
};

function cartesian<T>(arrs: T[][]): T[][] {
  if (arrs.length === 0) return [];
  return arrs.reduce<T[][]>(
    (acc, curr) => acc.flatMap(a => curr.map(c => [...a, c])),
    [[]]
  );
}

export default function Products() {
  // ----- add form state -----
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // shadcn <Select> values (controlled)
  const [trackInventory, setTrackInventory] = useState<"yes" | "no">("yes");
  const [statusSel, setStatusSel] = useState<"active" | "draft">("active");

  // ----- list / search -----
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [products, setProducts] = useState<MerchantProduct[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!uid) return;
    const q = query(
      collection(db, "merchantProducts"),
      where("merchantId", "==", uid),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: MerchantProduct[] = [];
      snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
      setProducts(rows);
    });
    return () => unsub();
  }, [uid]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return products;
    return products.filter((p) =>
      `${p.title} ${p.productType ?? ""}`.toLowerCase().includes(s)
    );
  }, [products, search]);

  // ====== Variants builder state ======
  // Up to 3 options
  const [options, setOptions] = useState<VariantOption[]>([
    { name: "Size", values: [] },
    { name: "Color", values: [] },
  ]);

  // Temp inputs for adding values quickly
  const [valueInputs, setValueInputs] = useState<string[]>(["", "", ""]);

  function setOptionName(idx: number, name: string) {
    setOptions(prev => {
      const next = [...prev];
      if (!next[idx]) next[idx] = { name, values: [] };
      next[idx] = { ...next[idx], name };
      return next;
    });
  }
  function addOptionRow() {
    if (options.length >= 3) return;
    setOptions(prev => [...prev, { name: `Option ${prev.length + 1}`, values: [] }]);
    setValueInputs(prev => [...prev, ""]);
  }
  function removeOptionRow(idx: number) {
    setOptions(prev => prev.filter((_, i) => i !== idx));
    setValueInputs(prev => prev.filter((_, i) => i !== idx));
    // also prune variantRows later via recompute
  }
  function addValue(idx: number) {
    const raw = (valueInputs[idx] || "").trim();
    if (!raw) return;
    const values = raw
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    setOptions(prev => {
      const next = [...prev];
      const existing = new Set(next[idx].values);
      values.forEach(v => existing.add(v));
      next[idx] = { ...next[idx], values: Array.from(existing) };
      return next;
    });
    setValueInputs(prev => prev.map((v, i) => (i === idx ? "" : v)));
  }
  function removeValue(idx: number, value: string) {
    setOptions(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], values: next[idx].values.filter(v => v !== value) };
      return next;
    });
  }

  // Generate combination rows from current options' values (1..3)
  const comboKeys: string[][] = useMemo(() => {
    const valueLists = options
      .filter(o => (o?.name || "").trim() && o.values.length > 0)
      .map(o => o.values);
    if (valueLists.length === 0) return [];
    return cartesian(valueLists);
  }, [options]);

  // Keep editable per-variant rows in state, keyed by "opt1|opt2|opt3"
  const [variantRows, setVariantRows] = useState<Record<string, VariantRow>>({});
  // re-seed rows when combos change (preserve existing edits)
  useEffect(() => {
    setVariantRows(prev => {
      const next: Record<string, VariantRow> = {};
      for (const combo of comboKeys) {
        const key = combo.join("|");
        const title = combo.join(" / ");
        next[key] = prev[key] ?? {
          id: key,
          options: combo,
          title,
          price: undefined,
          compareAtPrice: undefined,
          sku: "",
          quantity: undefined,
          barcode: "",
          weightGrams: undefined,
        };
      }
      return next;
    });
  }, [comboKeys]);

  // ====== helpers ======
  const handleAddProduct = () => setIsAddProductOpen(true);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remainingSlots = 5 - selectedImages.length;
    const filesToAdd = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast.error(`You can only upload ${remainingSlots} more image(s)`);
    }
    setSelectedImages([...selectedImages, ...filesToAdd]);
    filesToAdd.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => setImagePreviews((prev) => [...prev, reader.result as string]);
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (index: number) => {
    setSelectedImages((s) => s.filter((_, i) => i !== index));
    setImagePreviews((s) => s.filter((_, i) => i !== index));
  };

  async function getIdToken() {
    if (!auth.currentUser) throw new Error("You must be logged in.");
    return auth.currentUser.getIdToken();
  }

  async function startStagedUploads(idToken: string, files: File[]) {
    const payload = {
      files: files.map((f) => ({
        filename: f.name,
        mimeType: f.type || "image/jpeg",
        fileSize: f.size,
      })),
    };
    const r = await fetch("/api/admin/uploads/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "stagedUploadsCreate failed");
    return j.targets as StagedTarget[];
  }

  async function uploadFileToShopify(target: StagedTarget, file: File) {
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append("file", file); // must be 'file'
    const r = await fetch(target.url, { method: "POST", body: form });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Upload failed (${r.status}) ${t}`);
    }
    return target.resourceUrl;
  }

  // ====== submit ======
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!auth.currentUser) return toast.error("Please login again.");

    const form = new FormData(e.currentTarget as HTMLFormElement);
    const title = String(form.get("title") || "").trim();
    const description = String(form.get("description") || "").trim();

    // variant / inventory fields for base/default
    const price = Number(form.get("price") || 0);
    const compareAtPrice = Number(form.get("compare-price") || 0) || undefined;
    const cost = Number(form.get("cost") || 0) || undefined;
    const barcode = String(form.get("barcode") || "").trim() || undefined;
    const weightGrams = Number(form.get("weight") || 0) || undefined;
    const quantity = Number(form.get("quantity") || 0) || 0;

    // product meta
    const vendor = String(form.get("vendor") || "").trim() || undefined;
    const productType = String(form.get("product-type") || "").trim() || undefined;
    const tagsCsv = String(form.get("tags") || "");
    const tags = tagsCsv.split(",").map((t) => t.trim()).filter(Boolean);

    const seoTitle = String(form.get("seo-title") || "").trim() || undefined;
    const seoDescription = String(form.get("seo-description") || "").trim() || undefined;

    if (!title || !price) {
      toast.error("Please provide at least Title and Price.");
      return;
    }

    try {
      setBusy(true);
      const idToken = await getIdToken();

      // 1) staged uploads (if images picked)
      const localFiles = selectedImages.slice(0, 5);
      let resourceUrls: string[] = [];
      if (localFiles.length) {
        const targets = await startStagedUploads(idToken, localFiles);
        if (targets.length !== localFiles.length) throw new Error("Upload target count mismatch");
        resourceUrls = [];
        for (let i = 0; i < localFiles.length; i++) {
          const url = await uploadFileToShopify(targets[i], localFiles[i]);
          resourceUrls.push(url);
        }
      }

      // 2) prepare variantDraft ONLY for admin (not sent to Shopify now)
      const enabledOptions = options.filter(o => (o?.name || "").trim() && o.values.length > 0);
      let variantDraft: undefined | {
        options: VariantOption[];
        variants: Omit<VariantRow, "id">[]; // server doesn’t need the local id
      } = undefined;

      if (enabledOptions.length > 0 && Object.keys(variantRows).length > 0) {
        const variants = Object.values(variantRows).map(v => ({
          options: v.options,
          title: v.title,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          sku: (v.sku || "").trim() || undefined,
          quantity: v.quantity,
          barcode: (v.barcode || "").trim() || undefined,
          weightGrams: v.weightGrams,
        }));
        variantDraft = { options: enabledOptions, variants };
      }

      // 3) create product (server creates a single default variant on Shopify)
      const body = {
        title,
        description,
        price,
        compareAtPrice,
        barcode,
        weightGrams,
        inventory: {
          quantity,
          tracked: trackInventory === "yes",
          cost,
        },
        currency: "INR",
        tags,
        resourceUrls,
        vendor,
        productType,
        // UI choice; server will coerce to DRAFT when variantDraft exists
        status: statusSel,
        seo: seoTitle || seoDescription ? { title: seoTitle, description: seoDescription } : undefined,
        // NEW: store the seller-proposed variants for admin
        variantDraft,
      };

      const createRes = await fetch("/api/admin/products/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(body),
      });
      const j = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !j.ok) throw new Error(j.error || "Create product failed");

      toast.success("Product submitted for review. Admin will configure variants & publish.");
      setIsAddProductOpen(false);
      setSelectedImages([]);
      setImagePreviews([]);
      (e.target as HTMLFormElement).reset();

      // reset options/variants builder
      setOptions([{ name: "Size", values: [] }, { name: "Color", values: [] }]);
      setValueInputs(["", "", ""]);
      setVariantRows({});
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Failed to create product");
    } finally {
      setBusy(false);
    }
  };

  const handleEditProduct = (id: string) => toast.info(`Edit product ${id} (coming soon)`);
  const handleDeleteProduct = (id: string) => toast.error(`Delete product ${id} (coming soon)`);

  // ----- UI -----
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <Dialog open={isAddProductOpen} onOpenChange={setIsAddProductOpen}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add New Product</DialogTitle>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Product Images */}
              <div className="space-y-2">
                <Label>Product Images (Max 5)</Label>
                <div className="grid grid-cols-5 gap-4">
                  {imagePreviews.map((preview, index) => (
                    <div key={index} className="relative aspect-square">
                      <img
                        src={preview}
                        alt={`Preview ${index + 1}`}
                        className="w-full h-full object-cover rounded-md border"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute -top-2 -right-2 h-6 w-6 rounded-full"
                        onClick={() => removeImage(index)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  {selectedImages.length < 5 && (
                    <label className="aspect-square border-2 border-dashed rounded-md flex items-center justify-center cursor-pointer hover:bg-muted/50 transition-colors">
                      <div className="text-center">
                        <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Upload</span>
                      </div>
                      <input type="file" accept="image/*" multiple className="hidden" onChange={handleImageSelect} />
                    </label>
                  )}
                </div>
              </div>

              {/* Basic Info */}
              <div className="space-y-2">
                <Label htmlFor="title">Product Title *</Label>
                <Input id="title" name="title" placeholder="E.g., Premium Cotton T-Shirt" required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description *</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder="Describe your product..."
                  rows={4}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Base Price (used for default variant; admin can override per-variant later) */}
                <div className="space-y-2">
                  <Label htmlFor="price">Base Price (₹) *</Label>
                  <Input id="price" name="price" type="number" placeholder="999" min={0} step="0.01" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="compare-price">Base Compare at Price (₹)</Label>
                  <Input id="compare-price" name="compare-price" type="number" placeholder="1499" min={0} step="0.01" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cost">Cost per Item (₹)</Label>
                  <Input id="cost" name="cost" type="number" placeholder="500" min={0} step="0.01" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sku">SKU</Label>
                  <Input id="sku" placeholder="(Auto-generated for the default variant)" disabled />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="barcode">Barcode (ISBN, UPC, etc.)</Label>
                  <Input id="barcode" name="barcode" placeholder="123456789" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="weight">Weight (grams)</Label>
                  <Input id="weight" name="weight" type="number" placeholder="500" min={0} />
                </div>
              </div>

              {/* Inventory (base) */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity</Label>
                  <Input id="quantity" name="quantity" type="number" placeholder="100" min={0} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="track-inventory">Track Inventory</Label>
                  <Select value={trackInventory} onValueChange={(v) => setTrackInventory(v as any)}>
                    <SelectTrigger id="track-inventory">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Product meta */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="product-type">Product Type</Label>
                  <Input id="product-type" name="product-type" placeholder="E.g., T-Shirts" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vendor">Vendor</Label>
                  <Input id="vendor" name="vendor" placeholder="Brand name" />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="tags">Tags (comma-separated)</Label>
                <Input id="tags" name="tags" placeholder="casual, cotton, comfortable" />
              </div>

              {/* ===== Variants (for Admin) ===== */}
              <div className="space-y-3 border-t pt-4">
                <h3 className="font-semibold">Variants (optional, for admin to configure in Shopify)</h3>

                {/* Options editor */}
                <div className="grid gap-4">
                  {options.map((opt, idx) => (
                    <div key={idx} className="rounded-md border p-3 space-y-3">
                      <div className="flex items-center gap-2">
                        <Label className="min-w-[80px]">Option {idx + 1}</Label>
                        <Input
                          value={opt.name}
                          onChange={(e) => setOptionName(idx, e.target.value)}
                          placeholder={idx === 0 ? "Size" : idx === 1 ? "Color" : "Material"}
                          className="max-w-xs"
                        />
                        {options.length > 1 && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => removeOptionRow(idx)}
                            className="ml-auto"
                          >
                            Remove
                          </Button>
                        )}
                      </div>

                      {/* Values pills */}
                      <div className="flex flex-wrap gap-2">
                        {opt.values.map((v) => (
                          <Badge
                            key={v}
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => removeValue(idx, v)}
                            title="Click to remove"
                          >
                            {v} <span className="ml-1 opacity-60">×</span>
                          </Badge>
                        ))}
                      </div>

                      {/* Add values */}
                      <div className="flex items-center gap-2">
                        <Input
                          value={valueInputs[idx] || ""}
                          onChange={(e) =>
                            setValueInputs(prev => prev.map((v, i) => (i === idx ? e.target.value : v)))
                          }
                          placeholder="Enter values (comma separated), press Add"
                        />
                        <Button type="button" variant="secondary" onClick={() => addValue(idx)}>
                          Add
                        </Button>
                      </div>
                    </div>
                  ))}

                  {options.length < 3 && (
                    <Button type="button" variant="outline" onClick={addOptionRow} className="w-fit">
                      + Add another option
                    </Button>
                  )}
                </div>

                {/* Variants grid */}
                {comboKeys.length > 0 && (
                  <div className="space-y-2">
                    <Label>Variant combinations</Label>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left p-2">Variant</th>
                            <th className="text-left p-2">Price (₹)</th>
                            <th className="text-left p-2">Compare at (₹)</th>
                            <th className="text-left p-2">SKU (optional)</th>
                            <th className="text-left p-2">Qty</th>
                            <th className="text-left p-2">Barcode</th>
                            <th className="text-left p-2">Weight (g)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {comboKeys.map((combo) => {
                            const key = combo.join("|");
                            const row = variantRows[key];
                            return (
                              <tr key={key} className="border-t">
                                <td className="p-2">{row?.title || combo.join(" / ")}</td>
                                <td className="p-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={row?.price ?? ""}
                                    onChange={(e) =>
                                      setVariantRows(prev => ({
                                        ...prev,
                                        [key]: { ...(prev[key]!), price: e.target.value ? Number(e.target.value) : undefined },
                                      }))
                                    }
                                  />
                                </td>
                                <td className="p-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={row?.compareAtPrice ?? ""}
                                    onChange={(e) =>
                                      setVariantRows(prev => ({
                                        ...prev,
                                        [key]: { ...(prev[key]!), compareAtPrice: e.target.value ? Number(e.target.value) : undefined },
                                      }))
                                    }
                                  />
                                </td>
                                <td className="p-2">
                                  <Input
                                    value={row?.sku ?? ""}
                                    onChange={(e) =>
                                      setVariantRows(prev => ({
                                        ...prev,
                                        [key]: { ...(prev[key]!), sku: e.target.value },
                                      }))
                                    }
                                    placeholder="optional"
                                  />
                                </td>
                                <td className="p-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    value={row?.quantity ?? ""}
                                    onChange={(e) =>
                                      setVariantRows(prev => ({
                                        ...prev,
                                        [key]: { ...(prev[key]!), quantity: e.target.value ? Number(e.target.value) : undefined },
                                      }))
                                    }
                                  />
                                </td>
                                <td className="p-2">
                                  <Input
                                    value={row?.barcode ?? ""}
                                    onChange={(e) =>
                                      setVariantRows(prev => ({
                                        ...prev,
                                        [key]: { ...(prev[key]!), barcode: e.target.value },
                                      }))
                                    }
                                  />
                                </td>
                                <td className="p-2">
                                  <Input
                                    type="number"
                                    min={0}
                                    value={row?.weightGrams ?? ""}
                                    onChange={(e) =>
                                      setVariantRows(prev => ({
                                        ...prev,
                                        [key]: { ...(prev[key]!), weightGrams: e.target.value ? Number(e.target.value) : undefined },
                                      }))
                                    }
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      These variants are <b>not</b> sent to Shopify yet. Admin will create real Shopify variants based on this plan.
                    </p>
                  </div>
                )}
              </div>

              {/* SEO */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold">Search Engine Listing</h3>
                <div className="space-y-2">
                  <Label htmlFor="seo-title">SEO Title</Label>
                  <Input id="seo-title" name="seo-title" placeholder="Premium Cotton T-Shirt | DRIPPR" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="seo-description">SEO Description</Label>
                  <Textarea
                    id="seo-description"
                    name="seo-description"
                    placeholder="High quality cotton t-shirt, comfortable and stylish..."
                    rows={3}
                  />
                </div>
              </div>

              {/* Status */}
              <div className="space-y-2">
                <Label htmlFor="status">Product Status</Label>
                <Select value={statusSel} onValueChange={(v) => setStatusSel(v as any)}>
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  If variants are provided, the server will keep the Shopify product in <b>Draft</b> and mark it <b>In review</b>.
                </p>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setIsAddProductOpen(false);
                    setSelectedImages([]);
                    setImagePreviews([]);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Submitting…" : "Submit for Review"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Header + Add */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Products</h2>
            <p className="text-muted-foreground">Manage your product inventory</p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleAddProduct} className="gap-2">
            <Plus className="h-4 w-4" />
            Add Product
          </Button>
        </div>

        {/* List */}
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
              <CardTitle>All Products</CardTitle>
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search products..."
                  className="pl-9"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((p) => {
                    const img = p.image || (p.images?.[0] ?? "");
                    const statusClass =
                      p.status === "approved"
                        ? "bg-success/10 text-success border-success/20"
                        : p.status === "pending"
                        ? "bg-warning/10 text-warning border-warning/20"
                        : "bg-muted text-muted-foreground border-muted";
                    const statusText =
                      p.status === "approved" ? "Active" : p.status === "pending" ? "In review" : "Rejected";
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <img
                              src={img || "https://placehold.co/64x64?text=IMG"}
                              alt={p.title}
                              className="h-10 w-10 rounded-md object-cover bg-muted"
                            />
                            <div className="flex flex-col">
                              <span className="font-medium">{p.title}</span>
                              {p.sku ? (
                                <span className="text-xs text-muted-foreground">SKU: {p.sku}</span>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{p.productType || "-"}</TableCell>
                        <TableCell>{p.price != null ? `₹${Number(p.price).toLocaleString()}` : "-"}</TableCell>
                        <TableCell>
                          <Badge className={statusClass}>{statusText}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="icon" onClick={() => handleEditProduct(p.id)}>
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => handleDeleteProduct(p.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No products yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
