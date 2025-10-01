import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Edit, Trash2, X, Upload } from "lucide-react";
import { mockProducts } from "@/lib/mockData";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useState } from "react";

export default function Products() {
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [selectedImages, setSelectedImages] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);

  const handleAddProduct = () => {
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
      reader.onloadend = () => {
        setImagePreviews((prev) => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (index: number) => {
    setSelectedImages(selectedImages.filter((_, i) => i !== index));
    setImagePreviews(imagePreviews.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    toast.success("Product added successfully!");
    setIsAddProductOpen(false);
    setSelectedImages([]);
    setImagePreviews([]);
  };

  const handleEditProduct = (id: string) => {
    toast.info(`Edit product ${id}`);
  };

  const handleDeleteProduct = (id: string) => {
    toast.error(`Delete product ${id}`);
  };

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
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={handleImageSelect}
                      />
                    </label>
                  )}
                </div>
              </div>

              {/* Product Title */}
              <div className="space-y-2">
                <Label htmlFor="title">Product Title *</Label>
                <Input id="title" placeholder="E.g., Premium Cotton T-Shirt" required />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description">Description *</Label>
                <Textarea
                  id="description"
                  placeholder="Describe your product..."
                  rows={4}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Price */}
                <div className="space-y-2">
                  <Label htmlFor="price">Price (₹) *</Label>
                  <Input id="price" type="number" placeholder="999" required />
                </div>

                {/* Compare at Price */}
                <div className="space-y-2">
                  <Label htmlFor="compare-price">Compare at Price (₹)</Label>
                  <Input id="compare-price" type="number" placeholder="1499" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Cost per Item */}
                <div className="space-y-2">
                  <Label htmlFor="cost">Cost per Item (₹)</Label>
                  <Input id="cost" type="number" placeholder="500" />
                </div>

                {/* SKU */}
                <div className="space-y-2">
                  <Label htmlFor="sku">SKU</Label>
                  <Input id="sku" placeholder="SKU-001" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Barcode */}
                <div className="space-y-2">
                  <Label htmlFor="barcode">Barcode (ISBN, UPC, etc.)</Label>
                  <Input id="barcode" placeholder="123456789" />
                </div>

                {/* Weight */}
                <div className="space-y-2">
                  <Label htmlFor="weight">Weight (grams)</Label>
                  <Input id="weight" type="number" placeholder="500" />
                </div>
              </div>

              {/* Inventory */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity *</Label>
                  <Input id="quantity" type="number" placeholder="100" required />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="track-inventory">Track Inventory</Label>
                  <Select defaultValue="yes">
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

              <div className="grid grid-cols-2 gap-4">
                {/* Product Type */}
                <div className="space-y-2">
                  <Label htmlFor="product-type">Product Type</Label>
                  <Input id="product-type" placeholder="E.g., T-Shirts" />
                </div>

                {/* Vendor */}
                <div className="space-y-2">
                  <Label htmlFor="vendor">Vendor</Label>
                  <Input id="vendor" placeholder="Brand name" />
                </div>
              </div>

              {/* Collections */}
              <div className="space-y-2">
                <Label htmlFor="collections">Collections</Label>
                <Input id="collections" placeholder="Summer, Featured, New Arrivals" />
              </div>

              {/* Tags */}
              <div className="space-y-2">
                <Label htmlFor="tags">Tags</Label>
                <Input id="tags" placeholder="casual, cotton, comfortable" />
              </div>

              {/* SEO Section */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold">Search Engine Listing</h3>
                <div className="space-y-2">
                  <Label htmlFor="seo-title">SEO Title</Label>
                  <Input id="seo-title" placeholder="Premium Cotton T-Shirt | DRIPPR" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="seo-description">SEO Description</Label>
                  <Textarea
                    id="seo-description"
                    placeholder="High quality cotton t-shirt, comfortable and stylish..."
                    rows={3}
                  />
                </div>
              </div>

              {/* Status */}
              <div className="space-y-2">
                <Label htmlFor="status">Product Status</Label>
                <Select defaultValue="active">
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                  </SelectContent>
                </Select>
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
                <Button type="submit">Add Product</Button>
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
                          <img
                            src={product.image}
                            alt={product.name}
                            className="h-10 w-10 rounded-md object-cover"
                          />
                          <span className="font-medium">{product.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>{product.category}</TableCell>
                      <TableCell>₹{product.price}</TableCell>
                      <TableCell>
                        <span
                          className={
                            product.stock === 0
                              ? "text-destructive font-medium"
                              : product.stock < 50
                              ? "text-warning font-medium"
                              : ""
                          }
                        >
                          {product.stock}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            product.status === "active"
                              ? "bg-success/10 text-success border-success/20"
                              : "bg-muted text-muted-foreground border-muted"
                          }
                        >
                          {product.status === "active" ? "Active" : "Out of Stock"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditProduct(product.id)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteProduct(product.id)}
                          >
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
