import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Edit, Trash2, X, Upload } from "lucide-react";
import { mockProducts } from "@/lib/mockData";
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
import { useState } from "react";
import { auth } from "@/lib/firebase";

type StagedTarget = {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
};

export default function Products() {
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!auth.currentUser) return toast.error("Please login again.");

    const form = new FormData(e.currentTarget);
    const title = String(form.get("title") || "").trim();
    const description = String(form.get("description") || "").trim();
    const price = Number(form.get("price") || 0);
    const vendor = String(form.get("vendor") || "").trim() || undefined;
    const productType = String(form.get("product-type") || "").trim() || undefined;
    const tagsCsv = String(form.get("tags") || "");
    const tags = tagsCsv.split(",").map(t => t.trim()).filter(Boolean);
    const statusSel = String(form.get("status") || "active"); // 'active' | 'draft'
    const seoTitle = String(form.get("seo-title") || "").trim();
    const seoDescription = String(form.get("seo-description") || "").trim();

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

      // 2) create product
      const createRes = await fetch("/api/admin/products/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          title,
          description,
          price,
          currency: "INR",
          tags,
          resourceUrls,
          vendor,
          productType,
          status: statusSel,
          seo: (seoTitle || seoDescription) ? { title: seoTitle || undefined, description: seoDescription || undefined } : undefined,
        }),
      });
      const j = await createRes.json();
      if (!createRes.ok || !j.ok) throw new Error(j.error || "Create product failed");

      toast.success("Product created and synced with Shopify!");
      setIsAddProductOpen(false);
      setSelectedImages([]);
      setImagePreviews([]);
      (e.target as HTMLFormElement).reset();
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || "Failed to create product");
    } finally {
      setBusy(false);
    }
  };

  const handleEditProduct = (id: string) => toast.info(`Edit product ${id}`);
  const handleDeleteProduct = (id: string) => toast.error(`Delete product ${id}`);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <Dialog open={isAddProductOpen} onOpenChange={setIsAddProductOpen}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add New Product</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Product Images */}
              <div className="space-y-2">
                <Label>Product Images (Max 5)</Label>
                <div className="grid grid-cols-5 gap-4">
                  {imagePreviews.map((preview, index) => (
                    <div key={index} className="relative aspect-square">
                      <img src={preview} alt={`Preview ${index + 1}`} className="w-full h-full object-cover rounded-md border" />
                      <Button type="button" variant="destructive" size="icon" className="absolute -top-2 -right-2 h-6 w-6 rounded-full" onClick={() => removeImage(index)}>
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

              {/* Product Title */}
              <div className="space-y-2">
                <Label htmlFor="title">Product Title *</Label>
                <Input id="title" name="title" placeholder="E.g., Premium Cotton T-Shirt" required />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description">Description *</Label>
                <Textarea id="description" name="description" placeholder="Describe your product..." rows={4} required />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Price */}
                <div className="space-y-2">
                  <Label htmlFor="price">Price (₹) *</Label>
                  <Input id="price" name="price" type="number" placeholder="999" required />
                </div>

                {/* Compare at Price (optional UI – not wired yet) */}
                <div className="space-y-2">
                  <Label htmlFor="compare-price">Compare at Price (₹)</Label>
                  <Input id="compare-price" type="number" placeholder="1499" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Cost per Item – (not wired yet) */}
                <div className="space-y-2">
                  <Label htmlFor="cost">Cost per Item (₹)</Label>
                  <Input id="cost" type="number" placeholder="500" />
                </div>

                {/* SKU – will be overridden internally by our traceable SKU */}
                <div className="space-y-2">
                  <Label htmlFor="sku">SKU</Label>
                  <Input id="sku" placeholder="(Optional – internal SKU is auto-generated)" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Barcode – (not wired yet) */}
                <div className="space-y-2">
                  <Label htmlFor="barcode">Barcode (ISBN, UPC, etc.)</Label>
                  <Input id="barcode" placeholder="123456789" />
                </div>

                {/* Weight – (not wired yet) */}
                <div className="space-y-2">
                  <Label htmlFor="weight">Weight (grams)</Label>
                  <Input id="weight" type="number" placeholder="500" />
                </div>
              </div>

              {/* Inventory – (we’ll wire in Step 4) */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity *</Label>
                  <Input id="quantity" type="number" placeholder="100" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="track-inventory">Track Inventory</Label>
                  <Select defaultValue="yes">
                    <SelectTrigger id="track-inventory"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Product Type */}
                <div className="space-y-2">
                  <Label htmlFor="product-type">Product Type</Label>
                  <Input id="product-type" name="product-type" placeholder="E.g., T-Shirts" />
                </div>

                {/* Vendor */}
                <div className="space-y-2">
                  <Label htmlFor="vendor">Vendor</Label>
                  <Input id="vendor" name="vendor" placeholder="Brand name" />
                </div>
              </div>

              {/* Collections – (not wired) */}
              <div className="space-y-2">
                <Label htmlFor="collections">Collections</Label>
                <Input id="collections" placeholder="Summer, Featured, New Arrivals" />
              </div>

              {/* Tags */}
              <div className="space-y-2">
                <Label htmlFor="tags">Tags (comma-separated)</Label>
                <Input id="tags" name="tags" placeholder="casual, cotton, comfortable" />
              </div>

              {/* SEO Section */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold">Search Engine Listing</h3>
                <div className="space-y-2">
                  <Label htmlFor="seo-title">SEO Title</Label>
                  <Input id="seo-title" name="seo-title" placeholder="Premium Cotton T-Shirt | DRIPPR" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="seo-description">SEO Description</Label>
                  <Textarea id="seo-description" name="seo-description" placeholder="High quality cotton t-shirt, comfortable and stylish..." rows={3} />
                </div>
              </div>

              {/* Status */}
              <div className="space-y-2">
                <Label htmlFor="status">Product Status</Label>
                <Select defaultValue="active" name="status">
                  <SelectTrigger id="status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => {
                  setIsAddProductOpen(false);
                  setSelectedImages([]);
                  setImagePreviews([]);
                }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Add Product"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Products</h2>
            <p className="text-muted-foreground">Manage your product inventory</p>
          </div>
          <Button onClick={handleAddProduct} className="gap-2">
            <Plus className="h-4 w-4" />
            Add Product
          </Button>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
              <CardTitle>All Products</CardTitle>
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search products..." className="pl-9" />
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
                    <TableHead>Stock</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mockProducts.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <img src={product.image} alt={product.name} className="h-10 w-10 rounded-md object-cover" />
                          <span className="font-medium">{product.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>{product.category}</TableCell>
                      <TableCell>₹{product.price}</TableCell>
                      <TableCell>
                        <span className={
                          product.stock === 0 ? "text-destructive font-medium" :
                          product.stock < 50 ? "text-warning font-medium" : ""
                        }>
                          {product.stock}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge className={
                          product.status === "active"
                            ? "bg-success/10 text-success border-success/20"
                            : "bg-muted text-muted-foreground border-muted"
                        }>
                          {product.status === "active" ? "Active" : "Out of Stock"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" onClick={() => toast.info(`Edit product ${product.id}`)}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => toast.error(`Delete product ${product.id}`)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
