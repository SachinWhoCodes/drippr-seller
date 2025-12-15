import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Edit, Trash2, X, Upload, ImagePlus, ImageMinus } from "lucide-react";
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
  status?: "pending" | "approved" | "rejected" | "update_in_review" | "deleted";
  images?: string[];
  image?: string | null;
  createdAt?: number;
  sku?: string;          // now used for delete confirmation & required on create
  stock?: number;
  tags?: string[];
  vendor?: string | null;
};

type AddProductDraft = {
  title?: string;
  description?: string;
  basePriceInput?: string;
  compareAtPrice?: number | null;
  cost?: number | null;
  barcode?: string;
  weightGrams?: number | null;
  quantity?: number | null;
  vendor?: string;
  productType?: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  sku?: string;
  trackInventory?: "yes" | "no";
  statusSel?: "active" | "draft";
  handleDeliveryCharge?: boolean;
  imagePreviews?: string[]; // data URLs
  options?: VariantOption[];
  variantRows?: Omit<VariantRow, "id">[]; // store variant data (no id)
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
};

/** ---------------- Utils ---------------- */
function cartesian<T>(arrs: T[][]): T[][] {
  if (arrs.length === 0) return [];
  return arrs.reduce<T[][]>(
    (acc, curr) => acc.flatMap(a => curr.map(c => [...a, c])),
    [[]]
  );
}
function normSku(s: string) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "-");
}

// ---------------- Draft helpers ----------------
function getAddProductDraftKey(uid: string | null) {
  return `addProductDraft:${uid ?? "anonymous"}`;
}

async function saveAddProductDraft(uid: string | null, stateReader: () => Partial<AddProductDraft>) {
  if (!uid) return;
  try {
    const key = getAddProductDraftKey(uid);
    const draft = stateReader();
    localStorage.setItem(key, JSON.stringify(draft));
    // no need to await
  } catch (err) {
    console.warn("Failed to save add product draft", err);
  }
}

async function loadAddProductDraft(uid: string | null) : Promise<AddProductDraft | null> {
  if (!uid) return null;
  try {
    const key = getAddProductDraftKey(uid);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as AddProductDraft;
  } catch (err) {
    console.warn("Failed to load add product draft", err);
    return null;
  }
}

function clearAddProductDraft(uid: string | null) {
  if (!uid) return;
  try {
    const key = getAddProductDraftKey(uid);
    localStorage.removeItem(key);
  } catch (err) {
    console.warn("Failed to clear add product draft", err);
  }
}

/** --------------- Component --------------- */
export default function Products() {
  // ----- add form state -----
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [handleDeliveryCharge, setHandleDeliveryCharge] = useState(true);
  const [basePriceInput, setBasePriceInput] = useState<string>(""); 

  // shadcn <Select> values (controlled)
  const [trackInventory, setTrackInventory] = useState<"yes" | "no">("yes");
  const [statusSel, setStatusSel] = useState<"active" | "draft">("active");

  // ----- list / search -----
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [products, setProducts] = useState<MerchantProduct[]>([]);
  const [search, setSearch] = useState("");

  // --- Bulk upload dialog state (kept as-is) ---
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<Array<{ row: number; error: string }>>([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!uid) return;
    const qy = query(
      collection(db, "merchantProducts"),
      where("merchantId", "==", uid),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(qy, (snap) => {
      const rows: MerchantProduct[] = [];
      snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
      setProducts(rows);
    });
    return () => unsub();
  }, [uid]);



  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return products.filter(p => p.status !== "deleted");
    return products
      .filter(p => p.status !== "deleted")
      .filter((p) => `${p.title} ${p.productType ?? ""}`.toLowerCase().includes(s));
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


    // Auto-save while Add modal is open and restore on open
  useEffect(() => {
    let saveTimer: number | null = null;
    const saveNow = () => {
      if (!uid) return;
      // call save with a reader similar to the one used on close
      saveAddProductDraft(uid, () => {
        const form = document.getElementById("add-product-form") as HTMLFormElement | null;
        const f = form ? new FormData(form) : new FormData();
        const draft: AddProductDraft = {
          title: String(f.get("title") || "").trim() || undefined,
          description: String(f.get("description") || "").trim() || undefined,
          basePriceInput: basePriceInput || undefined,
          compareAtPrice: (() => { const v = String(f.get("compare-price") || ""); return v === "" ? undefined : Number(v); })(),
          cost: (() => { const v = String(f.get("cost") || ""); return v === "" ? undefined : Number(v); })(),
          barcode: String(f.get("barcode") || "").trim() || undefined,
          weightGrams: (() => { const v = String(f.get("weight") || ""); return v === "" ? undefined : Number(v); })(),
          quantity: (() => { const v = String(f.get("quantity") || ""); return v === "" ? undefined : Number(v); })(),
          vendor: String(f.get("vendor") || "").trim() || undefined,
          productType: String(f.get("product-type") || "").trim() || undefined,
          tags: (String(f.get("tags") || "") || "").split(",").map(t => t.trim()).filter(Boolean),
          seoTitle: String(f.get("seo-title") || "").trim() || undefined,
          seoDescription: String(f.get("seo-description") || "").trim() || undefined,
          sku: String(f.get("sku") || "").trim() || undefined,
          trackInventory: trackInventory,
          statusSel: statusSel,
          handleDeliveryCharge: handleDeliveryCharge,
          imagePreviews: imagePreviews,
          options: options.length ? options : undefined,
          variantRows: Object.keys(variantRows).length ? Object.values(variantRows).map(v => {
            const { id, ...rest } = v;
            return rest;
          }) : undefined,
        };
        return draft;
      });
    };

    // When modal opens, load draft (once)
    if (isAddProductOpen && uid) {
      (async () => {
        const draft = await loadAddProductDraft(uid);
        if (!draft) return;
        // set simple controlled state fields
        if (draft.basePriceInput != null) setBasePriceInput(String(draft.basePriceInput));
        if (draft.trackInventory) setTrackInventory(draft.trackInventory);
        if (draft.statusSel) setStatusSel(draft.statusSel);
        if (draft.handleDeliveryCharge != null) setHandleDeliveryCharge(!!draft.handleDeliveryCharge);
        if (draft.options) setOptions(draft.options);
        if (draft.variantRows) {
          const vr: Record<string, VariantRow> = {};
          draft.variantRows.forEach((v) => {
            const key = (v.options || []).join("|") || Math.random().toString(36).slice(2, 9);
            vr[key] = { id: key, options: v.options || [], title: v.title || (v.options || []).join(" / "), price: v.price, compareAtPrice: v.compareAtPrice, sku: v.sku || "", quantity: v.quantity, barcode: v.barcode || "", weightGrams: v.weightGrams };
          });
          setVariantRows(vr);
        }
        // form fields (uncontrolled inputs) — populate DOM directly
        const form = document.getElementById("add-product-form") as HTMLFormElement | null;
        if (form && draft) {
          const titleEl = form.querySelector(`#title`) as HTMLInputElement | null;
          if (titleEl) titleEl.value = draft.title || "";
          const descEl = form.querySelector(`#description`) as HTMLTextAreaElement | null;
          if (descEl) descEl.value = draft.description || "";
          const vendorEl = form.querySelector(`#vendor`) as HTMLInputElement | null;
          if (vendorEl) vendorEl.value = draft.vendor || "";
          const typeEl = form.querySelector(`#product-type`) as HTMLInputElement | null;
          if (typeEl) typeEl.value = draft.productType || "";
          const tagsEl = form.querySelector(`#tags`) as HTMLInputElement | null;
          if (tagsEl) tagsEl.value = (draft.tags || []).join(", ");
          const seoTitleEl = form.querySelector(`#seo-title`) as HTMLInputElement | null;
          if (seoTitleEl) seoTitleEl.value = draft.seoTitle || "";
          const seoDescEl = form.querySelector(`#seo-description`) as HTMLTextAreaElement | null;
          if (seoDescEl) seoDescEl.value = draft.seoDescription || "";
          const skuEl = form.querySelector(`#sku`) as HTMLInputElement | null;
          if (skuEl) skuEl.value = draft.sku || "";
          const comparePriceEl = form.querySelector(`#compare-price`) as HTMLInputElement | null;
          if (comparePriceEl) comparePriceEl.value = draft.compareAtPrice != null ? String(draft.compareAtPrice) : "";
          const costEl = form.querySelector(`#cost`) as HTMLInputElement | null;
          if (costEl) costEl.value = draft.cost != null ? String(draft.cost) : "";
          const barcodeEl = form.querySelector(`#barcode`) as HTMLInputElement | null;
          if (barcodeEl) barcodeEl.value = draft.barcode || "";
          const weightEl = form.querySelector(`#weight`) as HTMLInputElement | null;
          if (weightEl) weightEl.value = draft.weightGrams != null ? String(draft.weightGrams) : "";
          const qtyEl = form.querySelector(`#quantity`) as HTMLInputElement | null;
          if (qtyEl) qtyEl.value = draft.quantity != null ? String(draft.quantity) : "";
        }

        // images: restore previews and attempt to reconstruct File objects
        if (draft.imagePreviews && draft.imagePreviews.length) {
          setImagePreviews(draft.imagePreviews);
          try {
            const files = await Promise.all(
              draft.imagePreviews.map(async (dataUrl, idx) => {
                try {
                  const res = await fetch(dataUrl);
                  const blob = await res.blob();
                  const ext = blob.type.split("/")[1] || "png";
                  const file = new File([blob], `draft-image-${idx + 1}.${ext}`, { type: blob.type });
                  return file;
                } catch (err) {
                  return null;
                }
              })
            );
            setSelectedImages(files.filter(Boolean) as File[]);
          } catch (err) {
            console.warn("Could not reconstruct draft image Files", err);
          }
        }
      })();
    }

    // attach listeners to autosave during open
    const formEl = document.getElementById("add-product-form") as HTMLFormElement | null;
    function scheduleSave() {
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { saveNow(); }, 400);
    }
    if (isAddProductOpen && formEl) {
      formEl.addEventListener("input", scheduleSave);
      formEl.addEventListener("change", scheduleSave);
    }
    // also save on controlled-state changes
    if (isAddProductOpen) {
      scheduleSave();
    }

    return () => {
      if (formEl) {
        formEl.removeEventListener("input", scheduleSave);
        formEl.removeEventListener("change", scheduleSave);
      }
      if (saveTimer) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
    };
  // dependencies: when modal open and important pieces change we re-run
  }, [isAddProductOpen, uid, basePriceInput, imagePreviews, options, variantRows, trackInventory, statusSel, handleDeliveryCharge]);


  /** ====== helpers ====== */

  // to-be-deleted
  // const handleAddProduct = () => {
  //   setOptions([{ name: "Size", values: [] }, { name: "Color", values: [] }]);
  //   setValueInputs(["", "", ""]);
  //   setVariantRows({});
  //   setSelectedImages([]);
  //   setImagePreviews([]);
  //   setIsAddProductOpen(true);
  // };


  const handleAddProduct = () => {
    // open modal (restoration will run on open)
    setIsAddProductOpen(true);
  };

  const handleAddDialogOpenChange = (open: boolean) => {
    // if closing, capture a snapshot immediately
    if (!open) {
      // save once: pass a lightweight reader which collects current form + relevant state
      saveAddProductDraft(uid, () => {
        // gather values from DOM + controlled pieces
        const form = document.getElementById("add-product-form") as HTMLFormElement | null;
        const f = form ? new FormData(form) : new FormData();
        const draft: AddProductDraft = {
          title: String(f.get("title") || "").trim() || undefined,
          description: String(f.get("description") || "").trim() || undefined,
          basePriceInput: basePriceInput || undefined,
          compareAtPrice: (() => { const v = String(f.get("compare-price") || ""); return v === "" ? undefined : Number(v); })(),
          cost: (() => { const v = String(f.get("cost") || ""); return v === "" ? undefined : Number(v); })(),
          barcode: String(f.get("barcode") || "").trim() || undefined,
          weightGrams: (() => { const v = String(f.get("weight") || ""); return v === "" ? undefined : Number(v); })(),
          quantity: (() => { const v = String(f.get("quantity") || ""); return v === "" ? undefined : Number(v); })(),
          vendor: String(f.get("vendor") || "").trim() || undefined,
          productType: String(f.get("product-type") || "").trim() || undefined,
          tags: (String(f.get("tags") || "") || "").split(",").map(t => t.trim()).filter(Boolean),
          seoTitle: String(f.get("seo-title") || "").trim() || undefined,
          seoDescription: String(f.get("seo-description") || "").trim() || undefined,
          sku: String(f.get("sku") || "").trim() || undefined,
          trackInventory: trackInventory,
          statusSel: statusSel,
          handleDeliveryCharge: handleDeliveryCharge,
          imagePreviews: imagePreviews,
          options: options.length ? options : undefined,
          variantRows: Object.keys(variantRows).length ? Object.values(variantRows).map(v => {
            const { id, ...rest } = v;
            return rest;
          }) : undefined,
        };
        return draft;
      });
    }
    // update UI open state
    setIsAddProductOpen(open);
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

  const removeLocalImage = (index: number) => {
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

    const rawPrice = basePriceInput !== "" ? basePriceInput : String(form.get("price") ?? "0");
    const parsedPrice = Number(rawPrice || 0);
    const price = Number.isFinite(parsedPrice) ? parsedPrice + (handleDeliveryCharge ? 100 : 0) : 0;
    const compareAtPriceRaw = String(form.get("compare-price") ?? "");
    const compareAtPrice = compareAtPriceRaw === "" ? NaN : Number(compareAtPriceRaw);
    const cost = Number(form.get("cost") || 0) || undefined;
    const barcode = String(form.get("barcode") || "").trim() || undefined;
    const weightGrams = Number(form.get("weight") || 0) || undefined;
    const quantityRaw = String(form.get("quantity") ?? "");
    const quantity = quantityRaw === "" ? NaN : Number(quantityRaw);

    const vendor = String(form.get("vendor") || "").trim();
    const productType = String(form.get("product-type") || "").trim() || undefined;
    const tagsCsv = String(form.get("tags") || "");
    const tags = tagsCsv.split(",").map((t) => t.trim()).filter(Boolean);

    const seoTitle = String(form.get("seo-title") || "").trim();
    const seoDescription = String(form.get("seo-description") || "").trim();

    const sku = String(form.get("sku") || "").trim();

    // --- required checks per your request ---
    if (selectedImages.length === 0) return toast.error("Please add at least one product image.");
    if (!title || !price) return toast.error("Please provide Title and Price.");
    if (Number.isNaN(compareAtPrice)) return toast.error("Compare at Price is required.");
    if (!sku) return toast.error("SKU is required.");
    if (Number.isNaN(quantity)) return toast.error("Quantity is required.");
    if (!vendor) return toast.error("Vendor name is required.");
    if (!seoTitle || !seoDescription) return toast.error("SEO Title and SEO Description are required.");

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
        sku,              // <-- send to server
        seo: { title: seoTitle, description: seoDescription },
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
      clearAddProductDraft(uid);
      setIsAddProductOpen(false);
      setHandleDeliveryCharge(true);
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

  // existing variants (live) + images (live)
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [existingVariants, setExistingVariants] = useState<ExistingVariant[]>([]);
  const [removeVariantIds, setRemoveVariantIds] = useState<Record<string, boolean>>({});
  const [variantQuickEdits, setVariantQuickEdits] = useState<Record<string, { price?: number | ''; quantity?: number | '' }>>({});
  const [imagesLive, setImagesLive] = useState<string[]>([]);
  const [imageAddFiles, setImageAddFiles] = useState<File[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [deleteSel, setDeleteSel] = useState<Record<string, boolean>>({}); // url -> selected

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
      const r = await fetch(`/api/admin/products/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ op: "details", id: productId }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load product details");

      const prod = j.product || {};
      const variants: ExistingVariant[] = Array.isArray(prod.variants)
        ? prod.variants.map((v: any) => ({
            id: v.id,
            title: v.title || "",
            optionValues: Array.isArray(v.optionValues) ? v.optionValues : (v.title ? String(v.title).split(" / ") : []),
            price: v.price != null ? Number(v.price) : undefined,
            quantity: v.quantity != null ? Number(v.quantity) : undefined,
            sku: v.sku || undefined,
            barcode: v.barcode || undefined,
          }))
        : [];

      setExistingVariants(variants);
      setRemoveVariantIds({});
      setVariantQuickEdits({});
      setImagesLive(Array.isArray(prod.imagesLive) ? prod.imagesLive : []);
      setDeleteSel({});
      // planner defaults until details load
      setOptions([{ name: "Size", values: [] }, { name: "Color", values: [] }]);
      setValueInputs(["", "", ""]);
      setVariantRows({});
    } catch (e: any) {
      console.error(e);
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
    setImageAddFiles([]);
    setDeleteSel({});
    setIsEditOpen(true);
    fetchDetails(p.id); // fetch variants & images from Shopify
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

      const payload: any = { id: editing.id };

      // 1) LIVE updates (push instantly to Shopify)
      if (ePrice !== '' && ePrice !== editing.price) payload.price = Number(ePrice);
      if (eStock !== '' && eStock !== editing.stock) payload.stockQty = Number(eStock);

      // Per-variant live edits (price/qty)
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

      // 2) REVIEW updates (go to admin queue)
      if (eTitle.trim() && eTitle.trim() !== (editing.title || "")) payload.title = eTitle.trim();
      if (eDescription.trim() !== (editing.description || "")) payload.description = eDescription.trim();
      if (eProductType.trim() !== (editing.productType || "")) payload.productType = eProductType.trim();
      if (eVendor.trim() !== (editing.vendor || "")) payload.vendor = eVendor.trim();
      const newTags = eTags.split(",").map(t => t.trim()).filter(Boolean);
      if (JSON.stringify(newTags) !== JSON.stringify(editing.tags || [])) payload.tags = newTags;
      if (eCompareAt !== '') payload.compareAtPrice = Number(eCompareAt);
      if (eBarcode.trim()) payload.barcode = eBarcode.trim();
      if (eWeight !== '') payload.weightGrams = Number(eWeight);

      const toRemove = Object.entries(removeVariantIds)
        .filter(([, on]) => on)
        .map(([vid]) => vid);
      if (toRemove.length) payload.removeVariantIds = toRemove;

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

  /** ====== EDIT: image add/delete ====== */
  const onEditChooseImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setImageAddFiles(prev => [...prev, ...files].slice(0, 10)); // cap to 10 in one go
  };

  const onEditAttachImages = async () => {
    if (!editing) return;
    if (!imageAddFiles.length) return toast.error("Please choose images first.");
    try {
      setImageBusy(true);
      const idToken = await getIdToken();

      // 1) stage via op: imagesStage
      const stageRes = await fetch("/api/admin/products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          op: "imagesStage",
          files: imageAddFiles.map(f => ({ filename: f.name, mimeType: f.type || "image/jpeg", fileSize: f.size })),
        }),
      });
      const stageJson = await stageRes.json();
      if (!stageRes.ok || !stageJson.ok) throw new Error(stageJson.error || "imagesStage failed");
      const targets: StagedTarget[] = stageJson.targets || [];
      if (targets.length !== imageAddFiles.length) throw new Error("Stage target count mismatch");

      // 2) upload each file to stage target
      const resourceUrls: string[] = [];
      for (let i = 0; i < imageAddFiles.length; i++) {
        const t = targets[i];
        const fd = new FormData();
        for (const p of t.parameters) fd.append(p.name, p.value);
        fd.append("file", imageAddFiles[i]);
        const up = await fetch(t.url, { method: "POST", body: fd });
        if (!up.ok) {
          const txt = await up.text().catch(() => "");
          throw new Error(`Upload failed (${up.status}) ${txt}`);
        }
        resourceUrls.push(t.resourceUrl);
      }

      // 3) attach to Shopify + mirror in Firestore
      const attachRes = await fetch("/api/admin/products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ op: "imagesAttach", id: editing.id, resourceUrls }),
      });
      const attachJson = await attachRes.json();
      if (!attachRes.ok || !attachJson.ok) throw new Error(attachJson.error || "imagesAttach failed");

      setImagesLive(attachJson.images || []);
      setImageAddFiles([]);
      toast.success("Images added.");
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Failed to add images");
    } finally {
      setImageBusy(false);
    }
  };

  const onEditDeleteSelected = async () => {
    if (!editing) return;
    const urls = Object.entries(deleteSel).filter(([, on]) => on).map(([u]) => u);
    if (!urls.length) return toast.error("Select images to remove.");
    try {
      setImageBusy(true);
      const idToken = await getIdToken();
      const delRes = await fetch("/api/admin/products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ op: "imagesDelete", id: editing.id, urls }),
      });
      const j = await delRes.json();
      if (!delRes.ok || !j.ok) throw new Error(j.error || "imagesDelete failed");
      setImagesLive(j.images || []);
      setDeleteSel({});
      toast.success("Selected images removed.");
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Failed to remove images");
    } finally {
      setImageBusy(false);
    }
  };

  /** ====== DELETE flow (type SKU) ====== */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MerchantProduct | null>(null);
  const [typedSku, setTypedSku] = useState("");

  const handleDeleteProduct = (id: string) => {
    const p = products.find(x => x.id === id);
    if (!p) return toast.error("Product not found");
    if (!p.sku) {
      return toast.error("This product has no SKU recorded; cannot confirm deletion.");
    }
    setDeleteTarget(p);
    setTypedSku("");
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const required = normSku(deleteTarget.sku || "");
    if (!required) return toast.error("No SKU stored on product");
    if (normSku(typedSku) !== required) return toast.error("SKU does not match");

    try {
      const idToken = await getIdToken();
      const r = await fetch("/api/admin/products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ op: "delete", id: deleteTarget.id, typedSku }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Delete failed");
      toast.success("Product deleted.");
      setDeleteOpen(false);
      setDeleteTarget(null);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Failed to delete product");
    }
  };

  /** ----- Bulk upload (unchanged logic) ----- */
  function norm(s: any) {
    return String(s ?? "").trim().toLowerCase().replace(/\s+/g, "");
  }
  function num(v: any) {
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : undefined;
  }
  function csvToArr(v: any) {
    return String(v || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  function boolFromCell(v: any, defaultVal = true) {
    const s = String(v ?? "").trim().toLowerCase();
    if (!s) return defaultVal;
    if (["yes", "y", "true", "1"].includes(s)) return true;
    if (["no", "n", "false", "0"].includes(s)) return false;
    return defaultVal;
  }
  function buildVariantDraft(row: any) {
    const o1n = row["option1name"] || row["option_1_name"];
    const o1v = row["option1values"] || row["option_1_values"];
    const o2n = row["option2name"] || row["option_2_name"];
    const o2v = row["option2values"] || row["option_2_values"];
    const o3n = row["option3name"] || row["option_3_name"];
    const o3v = row["option3values"] || row["option_3_values"];

    const options: Array<{ name: string; values: string[] }> = [];
    if (o1n && o1v) options.push({ name: String(o1n).trim(), values: csvToArr(o1v) });
    if (o2n && o2v) options.push({ name: String(o2n).trim(), values: csvToArr(o2v) });
    if (o3n && o3v) options.push({ name: String(o3n).trim(), values: csvToArr(o3v) });

    if (!options.length) return undefined;

    const lists = options.map((o) => o.values);
    const combos = cartesian(lists);
    const variants = combos.map((vals) => ({
      options: vals,
      title: vals.join(" / "),
      price: num(row["variantprice"]) ?? num(row["price"]),
      compareAtPrice: num(row["variantcompareat"]) ?? num(row["compareatprice"]) ?? undefined,
      sku: String(row["variantsku"] ?? "").trim() || undefined,
      quantity: num(row["variantqty"]) ?? num(row["quantity"]) ?? 0,
      barcode: String(row["variantbarcode"] ?? "").trim() || undefined,
      weightGrams: num(row["variantweightgrams"]) ?? num(row["weightgrams"]) ?? undefined,
    }));

    return { options, variants };
  }
  function rowToCreateBody(row: any) {
    const map: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) map[norm(k)] = v;

    const title = String(map["title"] ?? "").trim();
    const basePrice = num(map["price"]);                // treat as base price
    if (!title || basePrice == null) throw new Error("Missing Title or Price");

    // NEW: delivery charge flag (defaults to true, like the Add form)
    const handleDelivery = boolFromCell(map["handledeliverycharge"], true);
    const price = basePrice + (handleDelivery ? 100 : 0);

    const compareAtPrice = num(map["compareatprice"]);
    const cost = num(map["cost"]);
    const barcode = String(map["barcode"] ?? "").trim() || undefined;
    const weightGrams = num(map["weightgrams"]);
    const quantity = num(map["quantity"]) ?? 0;

    const vendor = String(map["vendor"] ?? "").trim() || undefined;
    const productType = String(map["producttype"] ?? "").trim() || undefined;
    const tags = csvToArr(map["tags"]);
    const seoTitle = String(map["seotitle"] ?? "").trim() || undefined;
    const seoDescription = String(map["seodescription"] ?? "").trim() || undefined;
    const sku = String(map["sku"] ?? "").trim() || undefined;

    const resourceUrls = csvToArr(map["imageurls"]);
    const variantDraft = buildVariantDraft(map);

    return {
      title,
      description: String(map["description"] ?? "").trim(),
      price,                    // <- final price with delivery logic applied
      compareAtPrice,
      barcode,
      weightGrams,
      inventory: {
        quantity,
        tracked: true,
        cost,
      },
      currency: "INR",
      tags,
      resourceUrls: resourceUrls.length ? resourceUrls : undefined,
      vendor,
      productType,
      status: "active",
      sku,
      seo: seoTitle || seoDescription ? { title: seoTitle, description: seoDescription } : undefined,
      variantDraft,
    };
  }
  async function parseWorkbook(file: File) {
    const XLSX = (await import("xlsx")).default || (await import("xlsx"));
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    return rows as any[];
  }
  async function runBulkUpload() {
    if (!bulkFile) {
      toast.error("Please choose a file");
      return;
    }
    if (!auth.currentUser) {
      toast.error("Please login again.");
      return;
    }
    setBulkRunning(true);
    setBulkErrors([]);
    setBulkDone(0);
    try {
      const rows = await parseWorkbook(bulkFile);
      setBulkTotal(rows.length);
      const idToken = await getIdToken();
      for (let i = 0; i < rows.length; i++) {
        try {
          const body = rowToCreateBody(rows[i]);
          const res = await fetch("/api/admin/products/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify(body),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) throw new Error(j.error || "Create failed");
        } catch (e: any) {
          setBulkErrors((prev) => [...prev, { row: i + 2, error: e?.message || "Unknown error" }]);
        } finally {
          setBulkDone((d) => d + 1);
        }
      }
      toast.success("Bulk upload finished.");
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Bulk upload failed");
    } finally {
      setBulkRunning(false);
    }
  }

  /** ----- UI ----- */
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* ADD dialog */}
        <Dialog open={isAddProductOpen} onOpenChange={handleAddDialogOpenChange}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add New Product</DialogTitle>
            </DialogHeader>

            <form id="add-product-form" onSubmit={handleSubmit} className="space-y-8">
              {/* Product Images (required) */}
              <div className="space-y-2">
                <Label>Product Images (Min 1, Max 5) <span className="text-destructive">*</span></Label>
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
                        onClick={() => removeLocalImage(index)}
                        title="Remove"
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
                  <Input
                    id="price"
                    name="price"
                    type="number"
                    placeholder="999"
                    min={0}
                    step="0.01"
                    required
                    value={basePriceInput}
                    onChange={(e) => setBasePriceInput(e.target.value)}
                  />

                  {/* DELIVERY CHARGE CHECKBOX */}
                  <label className="inline-flex items-center gap-2 mt-2">
                    <input
                      type="checkbox"
                      checked={handleDeliveryCharge}
                      onChange={(e) => setHandleDeliveryCharge(e.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">Handle the delivery charge to the customer</span>
                  </label>

                  {/* FINAL BASE PRICE DISPLAY */}
                  <div className="mt-2 text-sm">
                    <span className="text-muted-foreground">Final base price: </span>
                    <span className="font-medium">
                      {/* compute final price for display (treat empty as 0) */}
                      ₹{(Number(basePriceInput || 0) + (handleDeliveryCharge ? 100 : 0)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">({handleDeliveryCharge ? "+₹100 delivery" : "no delivery added"})</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="compare-price">Compare at Price (₹) <span className="text-destructive">*</span></Label>
                  <Input id="compare-price" name="compare-price" type="number" placeholder="1499" min={0} step="0.01" required />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cost">Cost per Item (₹)</Label>
                  <Input id="cost" name="cost" type="number" placeholder="500" min={0} step="0.01" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sku">SKU <span className="text-destructive">*</span></Label>
                  <Input id="sku" name="sku" placeholder="UNIQ-SKU-123" required />
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
                  <Label htmlFor="quantity">Quantity <span className="text-destructive">*</span></Label>
                  <Input id="quantity" name="quantity" type="number" placeholder="100" min={0} required />
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
                  <Input id="product-type" name="product-type" placeholder="T-Shirts" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vendor">Vendor <span className="text-destructive">*</span></Label>
                  <Input id="vendor" name="vendor" placeholder="Brand name" required />
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

              {/* SEO (required) */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold">Search Engine Listing <span className="text-destructive">*</span></h3>
                <div className="space-y-2">
                  <Label htmlFor="seo-title">SEO Title</Label>
                  <Input id="seo-title" name="seo-title" placeholder="Premium Cotton T-Shirt | DRIPPR" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="seo-description">SEO Description</Label>
                  <Textarea
                    id="seo-description"
                    name="seo-description"
                    placeholder="High quality cotton t-shirt, comfortable and stylish..."
                    rows={3}
                    required
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
                  If variants are provided, the server will send the product for <b>Review</b> and mark it's status as <b>In review</b>.
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

              {/* Add form actions: Save draft, Discard, Submit */}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => {
                  clearAddProductDraft(uid);
                  // reset UI to blank same as successful submit reset
                  setOptions([{ name: "Size", values: [] }, { name: "Color", values: [] }]);
                  setValueInputs(["", "", ""]);
                  setVariantRows({});
                  setSelectedImages([]);
                  setImagePreviews([]);
                  setBasePriceInput("");
                  setHandleDeliveryCharge(true);
                  setTrackInventory("yes");
                  setStatusSel("active");
                  const form = document.getElementById("add-product-form") as HTMLFormElement | null;
                  form?.reset();
                  toast("Draft discarded.");
                }}>
                  Discard draft
                </Button>

                <Button type="button" variant="outline" onClick={() => {
                  // immediate save
                  saveAddProductDraft(uid, () => {
                    const form = document.getElementById("add-product-form") as HTMLFormElement | null;
                    const f = form ? new FormData(form) : new FormData();
                    return {
                      title: String(f.get("title") || "").trim() || undefined,
                      description: String(f.get("description") || "").trim() || undefined,
                      basePriceInput: basePriceInput || undefined,
                      imagePreviews: imagePreviews,
                      options: options.length ? options : undefined,
                      variantRows: Object.keys(variantRows).length ? Object.values(variantRows).map(v => {
                        const { id, ...rest } = v;
                        return rest;
                      }) : undefined,
                    } as AddProductDraft;
                  });
                  toast("Draft saved locally.");
                }}>
                  Save draft
                </Button>

                <Button type="submit" disabled={busy}>
                  {busy ? "Submitting…" : "Submit for review"}
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

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setIsBulkOpen(true)} className="gap-2">
            <Upload className="h-4 w-4" />
            Bulk upload
          </Button>
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
                        ? "bg-green-500/10 text-green-700 border-green-500/20"
                        : p.status === "pending"
                        ? "bg-yellow-500/10 text-yellow-700 border-yellow-500/20"
                        : p.status === "update_in_review"
                        ? "bg-blue-500/10 text-blue-700 border-blue-500/20"
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
                            <Button variant="ghost" size="icon" onClick={() => handleEditProduct(p.id)} title="Edit">
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => handleDeleteProduct(p.id)} title="Delete">
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

                {/* Images (live) */}
                <div className="border-t pt-4 space-y-3">
                  <h3 className="font-semibold">Product Images (live)</h3>

                  <div className="flex items-center gap-2">
                    <Label className="inline-flex items-center gap-2 px-3 py-2 border rounded-md cursor-pointer">
                      <ImagePlus className="h-4 w-4" />
                      <span>Choose files</span>
                      <input type="file" accept="image/*" multiple className="hidden" onChange={onEditChooseImages} />
                    </Label>
                    <Button type="button" onClick={onEditAttachImages} disabled={imageBusy || imageAddFiles.length === 0}>
                      {imageBusy ? "Adding…" : `Add selected images (${imageAddFiles.length})`}
                    </Button>
                    <Button type="button" variant="destructive" onClick={onEditDeleteSelected} disabled={imageBusy || !Object.values(deleteSel).some(Boolean)}>
                      <ImageMinus className="h-4 w-4 mr-2" />
                      {imageBusy ? "Removing…" : "Remove selected"}
                    </Button>
                  </div>

                  {loadingDetails ? (
                    <div className="text-sm text-muted-foreground">Loading images…</div>
                  ) : imagesLive.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No images.</div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                      {imagesLive.map((u) => (
                        <label key={u} className={`relative block rounded-md overflow-hidden border cursor-pointer ${deleteSel[u] ? "ring-2 ring-destructive" : ""}`}>
                          <img src={u} alt="img" className="w-full h-40 object-cover" />
                          <div className="absolute top-2 left-2 bg-white/80 px-1.5 py-0.5 rounded text-xs">
                            <input
                              type="checkbox"
                              checked={!!deleteSel[u]}
                              onChange={(e) => setDeleteSel(prev => ({ ...prev, [u]: e.target.checked }))}
                            />{" "}
                            Delete
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
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
                    Editing price/stock above updates Store instantly. Removing variants and any other changes go to admin for review.
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

        {/* DELETE dialog (type SKU) */}
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Delete Product</DialogTitle>
            </DialogHeader>
            {deleteTarget ? (
              <div className="space-y-4">
                <div className="border rounded-md p-3 space-y-1 text-sm">
                  <div><span className="font-medium">Title:</span> {deleteTarget.title}</div>
                  <div><span className="font-medium">Price:</span> {deleteTarget.price != null ? `₹${deleteTarget.price}` : "-"}</div>
                  <div><span className="font-medium">SKU:</span> {deleteTarget.sku || "—"}</div>
                </div>
                <p className="text-sm">
                  Type the SKU exactly to confirm deletion. This will remove the product from Drippr Store and mark it deleted here.
                </p>
                <div className="space-y-2">
                  <Label>Confirm by typing SKU</Label>
                  <Input value={typedSku} onChange={(e) => setTypedSku(e.target.value)} placeholder="Enter SKU" />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
                  <Button
                    variant="destructive"
                    onClick={confirmDelete}
                    disabled={!deleteTarget.sku || normSku(typedSku) !== normSku(deleteTarget.sku)}
                  >
                    Confirm delete
                  </Button>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        {/* BULK dialog (unchanged) */}
        <Dialog open={isBulkOpen} onOpenChange={setIsBulkOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Bulk Product Upload</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Upload file (.xlsx or .csv)</Label>
                <Input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => setBulkFile(e.target.files?.[0] || null)}
                  disabled={bulkRunning}
                />
                <p className="text-xs text-muted-foreground">
                  Use the provided template that you can <a href="https://seller.drippr.in/download/DRIPPR_Bulk_Template_Empty_D1.xlsx" className="text-blue-500" target="_blank">download from here</a>. The first sheet’s first row must be headers. See the sample file <a href="https://seller.drippr.in/download/DRIPPR_Bulk_Template_Sample_D1.xlsx" className="text-blue-500" target="_blank">here</a>.
                </p>
              </div>

              {/* Progress */}
              {bulkRunning || bulkDone > 0 ? (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Progress</span>
                    <span>
                      {bulkDone}/{bulkTotal}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded bg-muted overflow-hidden">
                    <div
                      className="h-2 bg-primary transition-all"
                      style={{ width: bulkTotal ? `${Math.floor((bulkDone / bulkTotal) * 100)}%` : "0%" }}
                    />
                  </div>
                  {!!bulkErrors.length && (
                    <div className="rounded-md border p-2 max-h-40 overflow-auto text-xs">
                      {bulkErrors.map((e, i) => (
                        <div key={i}>Row {e.row}: {e.error}</div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsBulkOpen(false)} disabled={bulkRunning}>
                  Close
                </Button>
                <Button onClick={runBulkUpload} disabled={!bulkFile || bulkRunning}>
                  {bulkRunning ? "Uploading…" : "Start upload"}
                </Button>
              </div>
            </div>
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
            These are <b>proposed additions</b>. Admin will review them before they go live.
          </p>
        </div>
      )}
    </div>
  );
}
