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

/** ---------------- Types ---------------- */
type StagedTarget = {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
};

type MerchantProduct = {
  id: string;
  title: string;
  description?: string;
  price?: number;
  productType?: string;
  status?: "pending" | "approved" | "rejected" | "update_in_review";
  images?: string[];
  image?: string;
  createdAt?: number;
  sku?: string;
  stock?: number;
  tags?: string[];
  vendor?: string | null;
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

type ExistingVariant = {
  id: string; // Shopify GID
  title: string;
  optionValues: string[]; // ["Red","M"]
  price?: number;
  quantity?: number;
  sku?: string;
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

/** --------------- Component --------------- */
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

  /** ====== Variants builder state (used by Add & Edit) ====== */
  const [options, setOptions] = useState<VariantOption[]>([
    { name: "Size", values: [] },
    { name: "Color", values: [] },
  ]);
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
  }
  function addValue(idx: number) {
    const raw = (valueInputs[idx] || "").trim();
    if (!raw) return;
    const values = raw.split(",").map(s => s.trim()).filter(Boolean);
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

  /** ====== helpers ====== */
  const handleAddProduct = () => {
    setOptions([{ name: "Size", values: [] }, { name: "Color", values: [] }]);
    setValueInputs(["", "", ""]);
    setVariantRows({});
    setIsAddProductOpen(true);
  };

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

  /** ====== ADD submit ====== */
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!auth.currentUser) return toast.error("Please login again.");

    const form = new FormData(e.currentTarget as HTMLFormElement);
    const title = String(form.get("title") || "").trim();
    const description = String(form.get("description") || "").trim();

    const price = Number(form.get("price") || 0);
    const compareAtPrice = Number(form.get("compare-price") || 0) || undefined;
    const cost = Number(form.get("cost") || 0) || undefined;
    const barcode = String(form.get("barcode") || "").trim() || undefined;
    const weightGrams = Number(form.get("weight") || 0) || undefined;
    const quantity = Number(form.get("quantity") || 0) || 0;

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

      const enabledOptions = options.filter(o => (o?.name || "").trim() && o.values.length > 0);
      let variantDraft: undefined | {
        options: VariantOption[];
        variants: Omit<VariantRow, "id">[];
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
        status: statusSel,
        seo: seoTitle || seoDescription ? { title: seoTitle, description: seoDescription } : undefined,
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

  /** ====== EDIT flow ====== */
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editing, setEditing] = useState<MerchantProduct | null>(null);

  // edit fields
  const [eTitle, setETitle] = useState("");
  const [eDescription, setEDescription] = useState("");
  const [ePrice, setEPrice] = useState<number | ''>(''); // for single-variant/global
  const [eStock, setEStock] = useState<number | ''>(''); // for single-variant/global
  const [eCompareAt, setECompareAt] = useState<number | ''>('');
  const [eBarcode, setEBarcode] = useState("");
  const [eWeight, setEWeight] = useState<number | ''>('');
  const [eProductType, setEProductType] = useState("");
  const [eVendor, setEVendor] = useState("");
  const [eTags, setETags] = useState("");

  // existing variants (from Shopify) + local edits/removals
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [existingVariants, setExistingVariants] = useState<ExistingVariant[]>([]);
  const [removeVariantIds, setRemoveVariantIds] = useState<Record<string, boolean>>({});
  const [variantQuickEdits, setVariantQuickEdits] = useState<Record<string, { price?: number | ''; quantity?: number | '' }>>({}); // keyed by variant.id

  function markRemove(vid: string, checked: boolean) {
    setRemoveVariantIds(prev => ({ ...prev, [vid]: checked }));
  }

  function setVariantEdit(vid: string, key: "price" | "quantity", value: number | '') {
    setVariantQuickEdits(prev => ({
      ...prev,
      [vid]: { ...(prev[vid] || {}), [key]: value }
    }));
  }

  async function fetchDetails(productId: string) {
    setLoadingDetails(true);
    try {
      const idToken = await getIdToken();
      const r = await fetch(`/api/admin/products/update?id=${productId}&live=1`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load product details");

      // Live variants come from Shopify via the API response
      const live = Array.isArray(j.liveVariants) ? j.liveVariants : [];

      // Map to our ExistingVariant shape; optionValues may not be present, derive from title
      const variants: ExistingVariant[] = live.map((v: any) => ({
        id: v.id,
        title: v.title || "",
        optionValues: Array.isArray(v.optionValues) ? v.optionValues : (v.title ? String(v.title).split(" / ") : []),
        price: v.price != null ? Number(v.price) : undefined,
        quantity: v.inventoryQuantity != null ? Number(v.inventoryQuantity) : undefined,
        sku: v.sku || undefined,
        barcode: v.barcode || undefined,
        weightGrams: v.weightGrams != null ? Number(v.weightGrams) : undefined,
      }));

      // We don’t rely on productOptions here; planner is for *new* variants
      setExistingVariants(variants);
      setRemoveVariantIds({});
      setVariantQuickEdits({});
      // reset planner for additions only
      setOptions([{ name: "Size", values: [] }, { name: "Color", values: [] }]);
      setValueInputs(["", "", ""]);
      setVariantRows({});
    } catch (e: any) {
      toast.error(e?.message || "Failed to load product details");
    } finally {
      setLoadingDetails(false);
    }
  }




  function openEdit(p: MerchantProduct) {
    setEditing(p);
    setETitle(p.title || "");
    setEDescription(p.description || "");
    setEPrice(typeof p.price === "number" ? p.price : '');
    setEStock(typeof p.stock === "number" ? p.stock : '');
    setECompareAt('');
    setEBarcode("");
    setEWeight('');
    setEProductType(p.productType || "");
    setEVendor(p.vendor || "");
    setETags((p.tags || []).join(", "));
    // planner defaults until details load
    setOptions([{ name: "Size", values: [] }, { name: "Color", values: [] }]);
    setValueInputs(["", "", ""]);
    setVariantRows({});
    setIsEditOpen(true);
    fetchDetails(p.id); // fetch variants/options
  }

  const handleEditProduct = (id: string) => {
    const p = products.find(x => x.id === id);
    if (!p) return toast.error("Product not found");
    openEdit(p);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;

    try {
      const idToken = await getIdToken();

      // Build payload exactly as the /api/admin/products/update endpoint expects
      const payload: any = { id: editing.id };

      // 1) LIVE updates (push instantly to Shopify)
      if (ePrice !== '' && ePrice !== editing.price) payload.price = Number(ePrice);
      if (eStock !== '' && eStock !== editing.stock) payload.stockQty = Number(eStock);

      // Optional: per-variant live edits (price/qty) from the “Existing variants” table
      const variantUpdates = existingVariants
        .map(v => {
          const edits = variantQuickEdits[v.id];
          if (!edits) return null;
          const upd: any = { id: v.id };
          if (edits.price !== '' && Number(edits.price) !== (v.price ?? undefined)) upd.price = Number(edits.price as number);
          if (edits.quantity !== '' && Number(edits.quantity) !== (v.quantity ?? undefined)) upd.quantity = Number(edits.quantity as number);
          return (upd.price != null || upd.quantity != null) ? upd : null;
        })
        .filter(Boolean) as Array<{ id: string; price?: number; quantity?: number }>;
      if (variantUpdates.length) payload.variants = variantUpdates;

      // 2) REVIEW updates (go to admin queue, sets status=update_in_review)
      if (eTitle.trim() && eTitle.trim() !== (editing.title || "")) payload.title = eTitle.trim();
      if (eDescription.trim() !== (editing.description || "")) payload.description = eDescription.trim();
      if (eProductType.trim() !== (editing.productType || "")) payload.productType = eProductType.trim();
      if (eVendor.trim() !== (editing.vendor || "")) payload.vendor = eVendor.trim();
      const newTags = eTags.split(",").map(t => t.trim()).filter(Boolean);
      if (JSON.stringify(newTags) !== JSON.stringify(editing.tags || [])) payload.tags = newTags;
      if (eCompareAt !== '') payload.compareAtPrice = Number(eCompareAt);
      if (eBarcode.trim()) payload.barcode = eBarcode.trim();
      if (eWeight !== '') payload.weightGrams = Number(eWeight);

      // request to remove existing variants (review)
      const toRemove = Object.entries(removeVariantIds)
        .filter(([, on]) => on)
        .map(([vid]) => vid);
      if (toRemove.length) payload.removeVariantIds = toRemove;

      // proposed NEW variants (planner → review)
      const enabledOptions = options.filter(o => (o?.name || "").trim() && o.values.length > 0);
      if (enabledOptions.length > 0 && Object.keys(variantRows).length > 0) {
        payload.variantDraft = {
          options: enabledOptions,
          variants: Object.values(variantRows).map(v => ({
            options: v.options,
            title: v.title,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            sku: v.sku || undefined,
            quantity: v.quantity,
            barcode: v.barcode || undefined,
            weightGrams: v.weightGrams,
          })),
        };
      }

      const r = await fetch("/api/admin/products/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Update failed");

      toast.success(
        j.review
          ? "Price/stock pushed. Other changes sent for review."
          : "Updated successfully."
      );

      setIsEditOpen(false);
      setEditing(null);
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Failed to update product");
    }
  };


  const handleDeleteProduct = (id: string) => toast.error(`Delete product ${id} (coming soon)`);

  /** ----- UI ----- */
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* ADD dialog */}
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

              {/* ===== Variants (plan for Admin) ===== */}
              <VariantPlanner
                options={options}
                setOptionName={setOptionName}
                removeOptionRow={removeOptionRow}
                valueInputs={valueInputs}
                setValueInputs={setValueInputs}
                addValue={addValue}
                removeValue={removeValue}
                addOptionRow={addOptionRow}
                comboKeys={comboKeys}
                variantRows={variantRows}
                setVariantRows={setVariantRows}
              />

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
                        : p.status === "update_in_review"
                        ? "bg-primary/10 text-primary border-primary/20"
                        : "bg-muted text-muted-foreground border-muted";
                    const statusText =
                      p.status === "approved"
                        ? "Active"
                        : p.status === "pending"
                        ? "In review"
                        : p.status === "update_in_review"
                        ? "Update in review"
                        : "Rejected";
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

        {/* EDIT dialog */}
        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Product</DialogTitle>
            </DialogHeader>

            {editing && (
              <form onSubmit={handleEditSubmit} className="space-y-6">
                {/* Basics */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Title</Label>
                    <Input value={eTitle} onChange={(e) => setETitle(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Product Type</Label>
                    <Input value={eProductType} onChange={(e) => setEProductType(e.target.value)} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea value={eDescription} onChange={(e) => setEDescription(e.target.value)} rows={4} />
                </div>

                {/* Global quick (for single-variant products) */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Price (₹) — pushes live immediately</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={ePrice}
                      onChange={(e) => setEPrice(e.target.value === "" ? "" : Number(e.target.value))}
                      placeholder="Leave unchanged to keep current"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Stock (Qty) — pushes live immediately</Label>
                    <Input
                      type="number"
                      min={0}
                      value={eStock}
                      onChange={(e) => setEStock(e.target.value === "" ? "" : Number(e.target.value))}
                      placeholder="Leave unchanged to keep current"
                    />
                  </div>
                </div>

                {/* Other review fields */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Compare at (₹)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={eCompareAt}
                      onChange={(e) => setECompareAt(e.target.value === "" ? "" : Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Barcode</Label>
                    <Input value={eBarcode} onChange={(e) => setEBarcode(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Weight (grams)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={eWeight}
                      onChange={(e) => setEWeight(e.target.value === "" ? "" : Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Vendor</Label>
                    <Input value={eVendor} onChange={(e) => setEVendor(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Tags (comma-separated)</Label>
                    <Input value={eTags} onChange={(e) => setETags(e.target.value)} />
                  </div>
                </div>

                {/* Existing variants (live) */}
                <div className="border-t pt-4">
                  <h3 className="font-semibold mb-2">Existing variants (live)</h3>
                  {loadingDetails ? (
                    <div className="text-sm text-muted-foreground">Loading variants…</div>
                  ) : existingVariants.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No variants found.</div>
                  ) : (
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left p-2">Variant</th>
                            <th className="text-left p-2">SKU</th>
                            <th className="text-left p-2">Barcode</th>
                            <th className="text-left p-2">Price (₹)</th>
                            <th className="text-left p-2">Stock</th>
                            <th className="text-left p-2">Remove?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {existingVariants.map((v) => {
                            const edits = variantQuickEdits[v.id] || {};
                            return (
                              <tr key={v.id} className="border-t">
                                <td className="p-2">{v.optionValues?.join(" / ") || v.title}</td>
                                <td className="p-2">{v.sku || "—"}</td>
                                <td className="p-2">{v.barcode || "—"}</td>
                                <td className="p-2 w-[160px]">
                                  <Input
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={edits.price ?? (v.price ?? "")}
                                    onChange={(e) =>
                                      setVariantEdit(v.id, "price", e.target.value === "" ? "" : Number(e.target.value))
                                    }
                                  />
                                </td>
                                <td className="p-2 w-[140px]">
                                  <Input
                                    type="number"
                                    min={0}
                                    value={edits.quantity ?? (v.quantity ?? "")}
                                    onChange={(e) =>
                                      setVariantEdit(v.id, "quantity", e.target.value === "" ? "" : Number(e.target.value))
                                    }
                                  />
                                </td>
                                <td className="p-2 w-[100px]">
                                  <label className="inline-flex items-center gap-2 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={!!removeVariantIds[v.id]}
                                      onChange={(e) => markRemove(v.id, e.target.checked)}
                                    />
                                    Remove
                                  </label>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Editing price/stock above updates Shopify instantly. Removing variants and any other changes go to admin for review.
                  </p>
                </div>

                {/* Add more variants (planner → review) */}
                <div className="border-t pt-4">
                  <h3 className="font-semibold mb-2">Add more variants (sent to admin)</h3>
                  <VariantPlanner
                    options={options}
                    setOptionName={setOptionName}
                    removeOptionRow={removeOptionRow}
                    valueInputs={valueInputs}
                    setValueInputs={setValueInputs}
                    addValue={addValue}
                    removeValue={removeValue}
                    addOptionRow={addOptionRow}
                    comboKeys={comboKeys}
                    variantRows={variantRows}
                    setVariantRows={setVariantRows}
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit">Save changes</Button>
                </div>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}

/** ---- Small reusable section for the variant plan UI ---- */
function VariantPlanner(props: {
  options: VariantOption[];
  setOptionName: (i: number, name: string) => void;
  removeOptionRow: (i: number) => void;
  valueInputs: string[];
  setValueInputs: React.Dispatch<React.SetStateAction<string[]>>;
  addValue: (i: number) => void;
  removeValue: (i: number, v: string) => void;
  addOptionRow: () => void;
  comboKeys: string[][];
  variantRows: Record<string, VariantRow>;
  setVariantRows: React.Dispatch<React.SetStateAction<Record<string, VariantRow>>>;
}) {
  const {
    options, setOptionName, removeOptionRow, valueInputs, setValueInputs,
    addValue, removeValue, addOptionRow, comboKeys, variantRows, setVariantRows
  } = props;

  return (
    <div className="space-y-3">
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

      {/* Variants grid (new additions only) */}
      {comboKeys.length > 0 && (
        <div className="space-y-2">
          <Label>Variant combinations (to add)</Label>
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
            These are <b>proposed additions</b>. Admin will create real Shopify variants based on this plan.
          </p>
        </div>
      )}
    </div>
  );
}
