import { useEffect, useState } from "react";
import { listQueueProducts, approveProduct, rejectProduct } from "@/lib/adminApi";
import { QueueProduct } from "@/types/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Search, Eye, CheckCircle, XCircle } from "lucide-react";
import { VariantDraftPreview } from "@/components/VariantDraftPreview";

export default function ProductQueue() {
  const [products, setProducts] = useState<QueueProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("in_review");
  const [search, setSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<QueueProduct | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const fetchProducts = async () => {
    setLoading(true);
    const res = await listQueueProducts({ status, q: search });
    if (res.ok) {
      setProducts(res.items);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchProducts();
  }, [status, search]);

  const handleApprove = async (product: QueueProduct) => {
    await approveProduct(product.id);
    toast.success(`${product.title} approved and published!`);
    setSelectedProduct(null);
    fetchProducts();
  };

  const handleReject = async () => {
    if (!selectedProduct || !rejectReason.trim()) return;
    await rejectProduct(selectedProduct.id, rejectReason);
    toast.error(`${selectedProduct.title} rejected.`);
    setRejectDialogOpen(false);
    setSelectedProduct(null);
    setRejectReason("");
    fetchProducts();
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      in_review: "default",
      draft: "secondary",
      active: "outline",
      rejected: "destructive",
    };
    return <Badge variant={variants[status] || "default"}>{status}</Badge>;
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row gap-4">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full md:w-48">
                <SelectValue />
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
          </div>
        </CardContent>
      </Card>

      {/* Products Table */}
      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
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
                {products.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell>
                      <img
                        src={product.image || "/placeholder.svg"}
                        alt={product.title}
                        className="w-12 h-12 object-cover rounded"
                      />
                    </TableCell>
                    <TableCell className="font-medium">{product.title}</TableCell>
                    <TableCell>{product.merchant?.name || "-"}</TableCell>
                    <TableCell>
                      {new Date(product.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{getStatusBadge(product.status)}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedProduct(product)}
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
                <SheetTitle>{selectedProduct.title}</SheetTitle>
                <SheetDescription>
                  Review product details and variants
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
                          className="w-full h-32 object-cover rounded border"
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Details */}
                <div className="space-y-2">
                  <div>
                    <span className="font-semibold">Description:</span>
                    <p className="text-sm text-muted-foreground">
                      {selectedProduct.description || "No description"}
                    </p>
                  </div>
                  <div>
                    <span className="font-semibold">Price:</span> ₹
                    {selectedProduct.price || "-"}
                  </div>
                  <div>
                    <span className="font-semibold">Type:</span>{" "}
                    {selectedProduct.productType || "-"}
                  </div>
                  <div>
                    <span className="font-semibold">Merchant:</span>{" "}
                    {selectedProduct.merchant?.name} ({selectedProduct.merchant?.email})
                  </div>
                  {selectedProduct.tags && selectedProduct.tags.length > 0 && (
                    <div>
                      <span className="font-semibold">Tags:</span>
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {selectedProduct.tags.map((tag, idx) => (
                          <Badge key={idx} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Variant Draft */}
                {selectedProduct.variantDraft && (
                  <VariantDraftPreview variantDraft={selectedProduct.variantDraft} />
                )}

                {/* Admin Notes */}
                <div>
                  <h4 className="font-semibold mb-2">Internal Notes</h4>
                  <Textarea
                    placeholder="Add notes about this product (visible only to admins)..."
                    rows={3}
                    defaultValue={selectedProduct.adminNotes || ""}
                  />
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-4">
                  <Button
                    className="flex-1"
                    onClick={() => handleApprove(selectedProduct)}
                  >
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Approve & Publish
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1"
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
              Please provide a reason for rejecting this product.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason for rejection..."
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject}>
              Reject Product
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
