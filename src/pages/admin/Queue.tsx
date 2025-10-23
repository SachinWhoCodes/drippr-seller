import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listQueueProducts, approveProduct, rejectProduct } from "@/lib/adminApi";
import { QueueProduct } from "@/types/admin";
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
import { VariantDraftPreview } from "@/components/VariantDraftPreview";

const PLACEHOLDER = "https://placehold.co/96x96?text=IMG";

type StatusFilter = "in_review" | "draft" | "all";

export default function ProductQueue() {
  const [products, setProducts] = useState<QueueProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const [status, setStatus] = useState<StatusFilter>("in_review");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState(""); // debounced search term
  const searchTimer = useRef<number | null>(null);

  const [selectedProduct, setSelectedProduct] = useState<QueueProduct | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // Debounce search input -> q
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => setQ(search.trim()), 300);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [search]);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listQueueProducts({ status, q });
      if (res.ok) setProducts(res.items);
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const handleApprove = async (product: QueueProduct) => {
    try {
      setActionBusy(true);
      await approveProduct(product.id);
      toast.success(`${product.title} approved and published!`);
      setSelectedProduct(null);
      fetchProducts();
    } catch (e: any) {
      toast.error(e?.message || "Failed to approve product");
    } finally {
      setActionBusy(false);
    }
  };

  const handleReject = async () => {
    if (!selectedProduct) return;
    if (!rejectReason.trim()) return toast.error("Please provide a reason.");
    try {
      setActionBusy(true);
      await rejectProduct(selectedProduct.id, rejectReason.trim());
      toast.success(`${selectedProduct.title} rejected.`);
      setRejectDialogOpen(false);
      setSelectedProduct(null);
      setRejectReason("");
      fetchProducts();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reject product");
    } finally {
      setActionBusy(false);
    }
  };

  const getStatusBadge = (s: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      in_review: "default",
      draft: "secondary",
      active: "outline",
      rejected: "destructive",
    };
    return <Badge variant={variants[s] || "default"} className="capitalize">{s.replace("_", " ")}</Badge>;
  };

  const headerRight = useMemo(() => {
    return (
      <div className="flex flex-col md:flex-row gap-4">
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-full md:w-48">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="in_review">In Review</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="all">All Status</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or merchant..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Button variant="outline" onClick={fetchProducts} disabled={loading}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>
    );
  }, [status, search, loading, fetchProducts]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          {headerRight}
        </CardContent>
      </Card>

      {/* Products Table */}
      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : products.length === 0 ? (
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
                {products.map((p) => (
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
                        <span className="block text-xs text-muted-foreground">{p.merchant.email}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "-"}
                    </TableCell>
                    <TableCell>{getStatusBadge(p.status)}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedProduct(p)}
                      >
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

      {/* Product Review Sheet */}
      <Sheet open={!!selectedProduct} onOpenChange={() => setSelectedProduct(null)}>
        <SheetContent className="overflow-y-auto w-full sm:max-w-2xl">
          {selectedProduct && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center justify-between">
                  <span>{selectedProduct.title}</span>
                  <span>{getStatusBadge(selectedProduct.status)}</span>
                </SheetTitle>
                <SheetDescription>
                  Review product details, images and the seller-provided variant draft.
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* Images */}
                {selectedProduct.images && selectedProduct.images.length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-2">Product Images</h4>
                    <div className="grid grid-cols-3 gap-2">
                      {selectedProduct.images.map((img, idx) => (
                        <img
                          key={idx}
                          src={img}
                          alt={`${selectedProduct.title} ${idx + 1}`}
                          className="w-full h-28 object-cover rounded border bg-muted"
                          onError={(e) => ((e.currentTarget as HTMLImageElement).src = PLACEHOLDER)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Details */}
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="font-semibold">Merchant:</span>{" "}
                    {selectedProduct.merchant?.name || "-"}{" "}
                    {selectedProduct.merchant?.email ? `(${selectedProduct.merchant.email})` : ""}
                  </div>
                  <div>
                    <span className="font-semibold">Base Price:</span>{" "}
                    {selectedProduct.price != null ? `₹${Number(selectedProduct.price).toLocaleString()}` : "-"}
                  </div>
                  <div>
                    <span className="font-semibold">Type:</span>{" "}
                    {selectedProduct.productType || "-"}
                  </div>
                  {selectedProduct.tags && selectedProduct.tags.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="font-semibold mr-1">Tags:</span>
                      {selectedProduct.tags.map((tag, idx) => (
                        <Badge key={idx} variant="secondary">{tag}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="pt-2">
                    <span className="font-semibold">Description:</span>
                    <p className="text-muted-foreground whitespace-pre-wrap mt-1">
                      {selectedProduct.description || "—"}
                    </p>
                  </div>
                </div>

                {/* Variant Draft (seller-provided options/values/prices) */}
                {selectedProduct.variantDraft ? (
                  <VariantDraftPreview variantDraft={selectedProduct.variantDraft} />
                ) : (
                  <div className="text-sm text-muted-foreground">
                    No variant draft provided by the seller.
                  </div>
                )}

                {/* Admin Notes (not persisted here; backend should accept it if needed) */}
                {selectedProduct.adminNotes ? (
                  <div className="text-xs text-muted-foreground">
                    Existing notes: {selectedProduct.adminNotes}
                  </div>
                ) : null}

                {/* Actions */}
                <div className="flex gap-2 pt-4">
                  <Button
                    className="flex-1"
                    disabled={actionBusy}
                    onClick={() => handleApprove(selectedProduct)}
                  >
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Approve & Publish
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1"
                    disabled={actionBusy}
                    onClick={() => setRejectDialogOpen(true)}
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

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Product</DialogTitle>
            <DialogDescription>
              Provide a reason for rejection. The seller can view this on their panel.
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
                setRejectDialogOpen(false);
                setRejectReason("");
              }}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={actionBusy || !rejectReason.trim()}>
              Reject Product
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
