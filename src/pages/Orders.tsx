import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Eye } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, orderBy, query, where, limit } from "firebase/firestore";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type LineItem = {
  title: string;
  sku?: string;
  quantity: number;
  price: number;
  total: number;
  variant_id?: any;
  product_id?: any;
};

type OrderDoc = {
  id: string;                // `${shopifyOrderId}_${merchantId}`
  shopifyOrderId: string;
  orderNumber?: string;
  merchantId: string;
  createdAt: number;         // epoch ms
  currency?: string;         // e.g. "INR"
  financialStatus?: string;  // "paid" | "pending" | "refunded" | "voided" | ...
  status?: string;           // "open" | "closed"
  lineItems?: LineItem[];
  subtotal?: number;
  raw?: { customer?: { id?: any; email?: string } };
};

type UiStatus = "all" | "pending" | "paid" | "refunded" | "voided" | "open" | "closed";

export default function Orders() {
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [orders, setOrders] = useState<OrderDoc[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<UiStatus>("all");

  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<OrderDoc | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!uid) return;
    // Recent 200 orders; adjust if needed
    const q = query(
      collection(db, "orders"),
      where("merchantId", "==", uid),
      orderBy("createdAt", "desc"),
      limit(200)
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: OrderDoc[] = [];
      snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
      setOrders(rows);
    });
    return () => unsub();
  }, [uid]);

  const currency = useMemo(
    () => orders.find((o) => o.currency)?.currency || "INR",
    [orders]
  );

  const money = (v: number | undefined) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(v || 0));

  // normalize a label to show in the badge
  const labelFor = (o: OrderDoc) =>
    (o.financialStatus || o.status || "pending").toLowerCase();

  // badge colors by normalized label
  const badgeClass = (o: OrderDoc) => {
    const l = labelFor(o);
    if (l === "paid") return "bg-success/10 text-success border-success/20";
    if (l === "pending" || l === "authorized") return "bg-warning/10 text-warning border-warning/20";
    if (l === "refunded" || l === "voided") return "bg-destructive/10 text-destructive border-destructive/20";
    if (l === "open") return "bg-primary/10 text-primary border-primary/20";
    return "bg-muted text-muted-foreground border-muted";
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      // filter by status
      if (filter !== "all") {
        const norm = labelFor(o);
        if (norm !== filter) return false;
      }
      if (!q) return true;

      const hay =
        `${o.orderNumber || o.shopifyOrderId} ${o.raw?.customer?.email ?? ""} ${(o.lineItems || [])
          .map((li) => `${li.title} x${li.quantity}`)
          .join(" ")}`.toLowerCase();

      return hay.includes(q);
    });
  }, [orders, search, filter]);

  const handleViewOrder = (o: OrderDoc) => {
    setSelected(o);
    setDetailOpen(true);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Orders</h2>
          <p className="text-muted-foreground">Manage customer orders</p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
              <CardTitle>All Orders</CardTitle>
              <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
                <Select value={filter} onValueChange={(v) => setFilter(v as UiStatus)}>
                  <SelectTrigger className="w-full sm:w-48">
                    <SelectValue placeholder="Filter by status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Orders</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="refunded">Refunded</SelectItem>
                    <SelectItem value="voided">Voided</SelectItem>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search orders..."
                    className="pl-9"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Products</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">
                        {o.orderNumber || o.shopifyOrderId}
                      </TableCell>
                      <TableCell>{o.raw?.customer?.email || "—"}</TableCell>
                      <TableCell className="max-w-xs truncate">
                        {(o.lineItems || [])
                          .map((li) => `${li.title} × ${li.quantity}`)
                          .join(", ")}
                      </TableCell>
                      <TableCell className="font-semibold">{money(o.subtotal)}</TableCell>
                      <TableCell>{new Date(o.createdAt).toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge className={badgeClass(o)}>{labelFor(o)}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" onClick={() => handleViewOrder(o)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        No orders found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Order details dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Order {selected?.orderNumber || selected?.shopifyOrderId}
            </DialogTitle>
          </DialogHeader>

          {selected ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground">Date</div>
                  <div>{new Date(selected.createdAt).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Customer</div>
                  <div>{selected.raw?.customer?.email || "—"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Status</div>
                  <div>
                    <Badge className={badgeClass(selected)}>{labelFor(selected)}</Badge>
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Amount</div>
                  <div className="font-semibold">{money(selected.subtotal)}</div>
                </div>
              </div>

              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="w-24 text-right">Qty</TableHead>
                      <TableHead className="w-28 text-right">Price</TableHead>
                      <TableHead className="w-28 text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(selected.lineItems || []).map((li, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <div className="flex flex-col">
                            <div className="font-medium">{li.title}</div>
                            {li.sku ? (
                              <div className="text-xs text-muted-foreground">SKU: {li.sku}</div>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{li.quantity}</TableCell>
                        <TableCell className="text-right">{money(li.price)}</TableCell>
                        <TableCell className="text-right">{money(li.total)}</TableCell>
                      </TableRow>
                    ))}
                    {(selected.lineItems || []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground">
                          No items.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="text-xs text-muted-foreground">
                Shopify Order ID: {selected.shopifyOrderId}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
