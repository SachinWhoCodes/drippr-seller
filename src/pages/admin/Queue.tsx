import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Search, Eye, CheckCircle, XCircle, RefreshCcw } from "lucide-react";

import { queueList, queueApprove, queueReject } from "@/lib/adminApi";

// ---------- Types (mirror backend response) ----------
type VariantDraft = {
  options?: { name: string; values: string[] }[];
  variants?: Array<{
    title: string;
    price?: number | string;
    compareAtPrice?: number | string;
    sku?: string;
    barcode?: string;
    weightGrams?: number;
    inventoryQty?: number;
  }>;
};

type QueueProduct = {
  id: string;
  merchantId: string;
  title: string;
  description?: string;
  price?: number;
  productType?: string | null;
  status: "pending" | "approved" | "rejected";
  tags?: string[];
  images?: string[];
  image?: string | null;
  createdAt?: number;
  merchant?: { uid?: string; name?: string; email?: string } | null;
  variantDraft?: VariantDraft | null;
  adminNotes?: string;
};

const PLACEHOLDER = "https://placehold.co/96x96?text=IMG";

// ---------- helpers ----------
const formatMoneyINR = (n?: number | string) =>
  `₹${Number(n ?? 0).toLocaleString("en-IN")}`;

function StatusBadge({ s }: { s: QueueProduct["status"] }) {
  const label = s === "pending" ? "In review" : s === "approved" ? "Approved" : "Rejected";
  const cls =
    s === "pending"
      ? "bg-warning/10 text-warning border-warning/20"
      : s === "approved"
      ? "bg-success/10 text-success border-success/20"
      : "bg-destructive/10 text-destructive border-destructive/20";
  return <Badge className={cls}>{label}</Badge>;
}

function VariantDraftPreview({ variantDraft }: { variantDraft?: VariantDraft | null }) {
  if (!variantDraft || (!variantDraft.options?.length && !variantDraft.variants?.length)) {
    return <div className="text-sm text-muted-foreground">No variant draft provided.</div>;
  }
  return (
    <div className="space-y-3">
      {variantDraft.options?.length ? (
        <div className="text-sm">
          <div className="font-semibold mb-1">Options</div>
          <ul className="list-disc ml-5 space-y-1">
            {variantDraft.options.map((opt, i) => (
              <li key={i}>
                <span className="font-medium">{opt.name}:</span>{" "}
                <span className="text-muted-foreground">{(opt.values || []).join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {variantDraft.variants?.length ? (
        <div className="text-sm">
          <div className="font-semibold mb-2">Variant Combos</div>
          <div className="border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Options</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Compare@</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Barcode</TableHead>
                  <TableHead>Weight(g)</TableHead>
                  <TableHead>Qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {variantDraft.variants.map((v, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-medium">{v.title || "—"}</TableCell>
                    <TableCell>{v.price != null ? formatMoneyINR(v.price) : "—"}</TableCell>
                    <TableCell>{v.compareAtPrice != null ? formatMoneyINR(v.compareAtPrice) : "—"}</TableCell>
                    <TableCell className="text-xs">{v.sku || "—"}</TableCell>
                    <TableCell className="text-xs">{v.barcode || "—"}</TableCell>
                    <TableCell>{v.weightGrams ?? "—"}</TableCell>
                    <TableCell>{v.inventoryQty ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------- Page ----------
type StatusFilter = "pending" | "approved" | "rejected" | "all";

export default function ProductQueue() {
  const [items, setItems] = useState<QueueProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const [status, setStatus] = useState<StatusFilter>("pending");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const debounce = useRef<number | null>(null);

  const [selected, setSelected] = useState<QueueProduct | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // debounce search
  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => setQ(search.trim().toLowerCase()), 300);
    return () => debounce.current && window.clearTimeout(debounce.current);
  }, [search]);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await queueList({
        status: status === "all" ? undefined : status,
        limit: 300,
      });
      const base = (resp.items || []) as QueueProduct[];
      const filtered = q
        ? base.filter((p) =>
            `${p.title || ""} ${p.merchant?.name || ""} ${p.merchant?.email || ""}`
              .toLowerCase()
              .includes(q)
          )
        : base;
      setItems(filtered);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const approve = async (product: QueueProduct) => {
    try {
      setActionBusy(true);
      await queueApprove(product.id); // backend publishes / marks approved
      toast.success(`${product.title} approved`);
      setSelected(null);
      fetchQueue();
    } catch (e: any) {
      toast.error(e?.message || "Approve failed");
    } finally {
      setActionBusy(false);
    }
  };

  const reject = async () => {
    if (!selected) return;
    if (!rejectReason.trim()) return toast.error("Please add a reason");
    try {
      setActionBusy(true);
      await queueReject(selected.id, rejectReason.trim());
      toast.success(`${selected.title} rejected`);
      setRejectOpen(false);
      setRejectReason("");
      setSelected(null);
      fetchQueue();
    } catch (e: any) {
      toast.error(e?.message || "Reject failed");
    } finally {
      setActionBusy(false);
    }
  };

  const header = useMemo(
    () => (
      <div className="flex flex-col md:flex-row gap-4">
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-full md:w-48">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">In Review</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="all">All Status</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or merchant…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Button variant="outline" onClick={fetchQueue} disabled={loading}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>
    ),
    [status, search, loading, fetchQueue]
  );

  return (
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">{header}</CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="text-center text-muted-foreground py-12">
                No products found.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Image</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Merchant</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <img
                          src={p.image || p.images?.[0] || PLACEHOLDER}
                          alt={p.title}
                          className="w-12 h-12 object-cover rounded border bg-muted"
                          onError={(e) => ((e.currentTarget as HTMLImageElement).src = PLACEHOLDER)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{p.title}</TableCell>
                      <TableCell>
                        {p.merchant?.name || "-"}
                        {p.merchant?.email ? (
                          <span className="block text-xs text-muted-foreground">
                            {p.merchant.email}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "-"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge s={p.status} />
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => setSelected(p)}>
                          <Eye className="h-4 w-4 mr-1" />
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Review Sheet */}
        <Sheet open={!!selected} onOpenChange={() => setSelected(null)}>
          <SheetContent className="overflow-y-auto w-full sm:max-w-2xl">
            {selected && (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center justify-between">
                    <span>{selected.title}</span>
                    <StatusBadge s={selected.status} />
                  </SheetTitle>
                  <SheetDescription>
                    Review product details, images, and the seller-provided variant draft.
                  </SheetDescription>
                </SheetHeader>

                <div className="mt-6 space-y-6">
                  {selected.images?.length ? (
                    <div>
                      <h4 className="font-semibold mb-2">Product Images</h4>
                      <div className="grid grid-cols-3 gap-2">
                        {selected.images.map((img, idx) => (
                          <img
                            key={idx}
                            src={img}
                            alt={`${selected.title} ${idx + 1}`}
                            className="w-full h-28 object-cover rounded border bg-muted"
                            onError={(e) =>
                              ((e.currentTarget as HTMLImageElement).src = PLACEHOLDER)
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="font-semibold">Merchant:</span>{" "}
                      {selected.merchant?.name || "-"}{" "}
                      {selected.merchant?.email ? `(${selected.merchant.email})` : ""}
                    </div>
                    <div>
                      <span className="font-semibold">Base Price:</span>{" "}
                      {selected.price != null ? formatMoneyINR(selected.price) : "—"}
                    </div>
                    <div>
                      <span className="font-semibold">Type:</span>{" "}
                      {selected.productType || "-"}
                    </div>
                    {selected.tags?.length ? (
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className="font-semibold mr-1">Tags:</span>
                        {selected.tags.map((tag, idx) => (
                          <Badge key={idx} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    <div className="pt-2">
                      <span className="font-semibold">Description:</span>
                      <p className="text-muted-foreground whitespace-pre-wrap mt-1">
                        {selected.description || "—"}
                      </p>
                    </div>
                  </div>

                  <VariantDraftPreview variantDraft={selected.variantDraft} />

                  <div className="flex gap-2 pt-4">
                    <Button className="flex-1" disabled={actionBusy} onClick={() => approve(selected)}>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      className="flex-1"
                      disabled={actionBusy}
                      onClick={() => setRejectOpen(true)}
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>

        {/* Reject dialog */}
        <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject Product</DialogTitle>
              <DialogDescription>
                Provide a reason for rejection — the seller will see this in their panel.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              placeholder="Reason for rejection…"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setRejectOpen(false);
                  setRejectReason("");
                }}
                disabled={actionBusy}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={reject} disabled={actionBusy || !rejectReason.trim()}>
                Reject Product
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
  );
}
