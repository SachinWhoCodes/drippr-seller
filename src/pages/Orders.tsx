import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Eye, Download, CheckCircle2, Truck } from "lucide-react";
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
import { toast } from "sonner";

import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot, orderBy, query, where, limit } from "firebase/firestore";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// --- Types ---

type LineItem = {
  title: string;
  sku?: string;
  quantity: number;
  price: number;
  total: number;
  variant_id?: any;
  product_id?: any;
};

type WorkflowStatus =
  | "vendor_pending"
  | "vendor_accepted"
  | "pickup_assigned"
  | "dispatched"
  | "vendor_expired"
  | "admin_overdue";

type OrderDoc = {
  id: string;                // `${shopifyOrderId}_${merchantId}`
  shopifyOrderId: string;
  orderNumber?: string;
  merchantId: string;
  createdAt: number;         // epoch ms
  currency?: string;
  financialStatus?: string;
  status?: string;
  lineItems?: LineItem[];
  subtotal?: number;

  raw?: { customer?: { id?: any; email?: string } };
  customerEmail?: string | null;

  workflowStatus?: WorkflowStatus;
  vendorAcceptBy?: number;
  vendorAcceptedAt?: number | null;
  adminPlanBy?: number | null;
  adminPlannedAt?: number | null;

  pickupPlan?: {
    pickupWindow?: string | null;
    pickupAddress?: string | null;
    notes?: string | null;
  } | null;

  deliveryPartner?: {
    name?: string | null;
    phone?: string | null;
    etaText?: string | null;
    trackingUrl?: string | null;
  } | null;

  dispatchedAt?: number | null;

  invoice?: {
    status?: "none" | "generating" | "ready";
    url?: string;
    generatedAt?: number;
  } | null;
};

type UiFilter =
  | "all"
  | "pay:pending"
  | "pay:paid"
  | "pay:refunded"
  | "pay:voided"
  | "ord:open"
  | "ord:closed"
  | "wf:vendor_pending"
  | "wf:vendor_accepted"
  | "wf:pickup_assigned"
  | "wf:dispatched"
  | "wf:vendor_expired"
  | "wf:admin_overdue";

const THIRTY_MIN = 30 * 60 * 1000;

// --- Helper Functions ---

function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ✅ SHARED LOGIC: 5 PM Rule
// If created after 5:00 PM (17:00), SLA starts next day at 10:00 AM
// Returns the DEADLINE timestamp (SLA Start + 3 Hours)
function getSlaDeadline(createdAtStr: string | number) {
  const d = new Date(createdAtStr);
  const hour = d.getHours();

  let slaStartTime = d.getTime();

  if (hour >= 17) {
    const tomorrow = new Date(d);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0); // 10:00 AM
    slaStartTime = tomorrow.getTime();
  }

  // Deadline is 3 hours after the calculated start time
  return slaStartTime + (3 * 60 * 60 * 1000); 
}

export default function Orders() {
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [orders, setOrders] = useState<OrderDoc[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<UiFilter>("all");

  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<OrderDoc | null>(null);

  const [now, setNow] = useState(Date.now());
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
    return () => unsub();
  }, []);

  // Live timer tick
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Firestore subscription
  useEffect(() => {
    if (!uid) return;
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

  // Keep selected order fresh
  useEffect(() => {
    if (!selected) return;
    const fresh = orders.find((o) => o.id === selected.id);
    if (fresh) setSelected(fresh);
  }, [orders, selected?.id]);

  const currency = useMemo(
    () => orders.find((o) => o.currency)?.currency || "INR",
    [orders]
  );

  const money = (v: number | undefined) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(v || 0));

  const customerFor = (o: OrderDoc) => o.customerEmail || o.raw?.customer?.email || "—";
  const payLabelFor = (o: OrderDoc) => (o.financialStatus || "pending").toLowerCase();
  const ordLabelFor = (o: OrderDoc) => (o.status || "open").toLowerCase();

  // --- Logic: Status Calculation ---
  const workflowFor = (o: OrderDoc): WorkflowStatus => {
    // 1. If already moved past pending, return actual status
    if (o.workflowStatus === "vendor_accepted") return "vendor_accepted";
    if (o.workflowStatus === "pickup_assigned") return "pickup_assigned";
    if (o.workflowStatus === "dispatched") return "dispatched";

    // 2. If technically "pending", check the 5 PM Rule
    if (o.workflowStatus === "vendor_pending" || !o.workflowStatus) {
      const deadline = getSlaDeadline(o.createdAt);
      
      // Return 'vendor_expired' for RED color, but logic allows action
      if (now > deadline) {
        return "vendor_expired";
      }
      return "vendor_pending";
    }

    return "vendor_pending";
  };

  const timeLeftMs = (o: OrderDoc): { label: string; ms: number } | null => {
    const st = workflowFor(o);

    // Show timer for both Pending AND Expired
    if (st === "vendor_pending" || st === "vendor_expired") {
      const deadline = getSlaDeadline(o.createdAt);
      return { label: "Accept in", ms: deadline - now };
    }

    if (st === "vendor_accepted" || st === "admin_overdue") {
      const acceptedAt = Number(o.vendorAcceptedAt || 0) || now;
      const planBy = Number(o.adminPlanBy || (acceptedAt + THIRTY_MIN));
      return { label: "Admin plan in", ms: planBy - now };
    }

    return null;
  };

  // --- Filtering Logic ---
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return orders.filter((o) => {
      const currentStatus = workflowFor(o);

      if (filter !== "all") {
        const [kind, val] = filter.split(":") as [string, string];

        if (kind === "wf") {
          // SPECIAL HANDLING: "Pending" filter shows "Pending" + "Expired"
          if (val === 'vendor_pending') {
             if (currentStatus !== 'vendor_pending' && currentStatus !== 'vendor_expired') return false;
          } else {
             // Exact match for others
             if (currentStatus !== val) return false;
          }
        } else if (kind === "pay") {
          if (payLabelFor(o) !== val) return false;
        } else if (kind === "ord") {
          if (ordLabelFor(o) !== val) return false;
        }
      }

      if (!q) return true;
      const itemsText = (o.lineItems || []).map((li) => `${li.title} x${li.quantity}`).join(" ");
      const hay = `${o.orderNumber || o.shopifyOrderId} ${customerFor(o)} ${itemsText}`.toLowerCase();
      return hay.includes(q);
    });
  }, [orders, search, filter, now]);

  const handleViewOrder = (o: OrderDoc) => {
    setSelected(o);
    setDetailOpen(true);
  };

  // --- API Calls ---
  async function authedJsonPost(url: string, body: any) {
    const u = auth.currentUser;
    if (!u) throw new Error("Not logged in");
    const token = await u.getIdToken();
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || "Request failed");
    return data;
  }

  async function downloadInvoice(orderId: string, urlFromDoc?: string) {
    const u = auth.currentUser;
    if (!u) return toast.error("Please login again");
    const token = await u.getIdToken();

    const url = urlFromDoc || `/api/orders/invoice?orderId=${encodeURIComponent(orderId)}`;
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!r.ok) {
      toast.error("Failed to download invoice");
      return;
    }

    const blob = await r.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `billing-slip_${selected?.orderNumber || selected?.shopifyOrderId || orderId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(objectUrl);
  }

  async function onAcceptSelected() {
    if (!selected) return;
    setActionBusy(true);
    try {
      await authedJsonPost("/api/orders/accept", { orderId: selected.id });
      toast.success("Order accepted");
    } catch (e: any) {
      toast.error(e?.message || "Failed to accept");
    } finally {
      setActionBusy(false);
    }
  }

  async function onDispatchSelected() {
    if (!selected) return;
    setActionBusy(true);
    try {
      await authedJsonPost("/api/orders/mark-dispatched", { orderId: selected.id });
      toast.success("Marked as dispatched");
    } catch (e: any) {
      toast.error(e?.message || "Failed to dispatch");
    } finally {
      setActionBusy(false);
    }
  }

  // --- Styling Helpers ---
  const workflowBadgeText = (st: WorkflowStatus) => {
    switch (st) {
      case "vendor_pending": return "Pending Acceptance";
      case "vendor_expired": return "Expired (Action Required)";
      case "vendor_accepted": return "Accepted (Admin Planning)";
      case "pickup_assigned": return "Pickup Assigned";
      case "dispatched": return "Dispatched";
      case "admin_overdue": return "Admin Overdue";
      default: return st;
    }
  };

  const workflowBadgeClass = (st: WorkflowStatus) => {
    if (st === "vendor_pending") return "bg-warning/10 text-warning border-warning/20";
    if (st === "vendor_accepted") return "bg-primary/10 text-primary border-primary/20";
    if (st === "pickup_assigned") return "bg-success/10 text-success border-success/20";
    if (st === "dispatched") return "bg-success/10 text-success border-success/20";
    // Red for expired/overdue
    if (st === "vendor_expired" || st === "admin_overdue") return "bg-destructive/10 text-destructive border-destructive/20";
    return "bg-muted text-muted-foreground border-muted";
  };

  const payBadgeClass = (o: OrderDoc) => {
    const l = payLabelFor(o);
    if (l === "paid") return "bg-success/10 text-success border-success/20";
    if (l === "pending" || l === "authorized") return "bg-warning/10 text-warning border-warning/20";
    if (l === "refunded" || l === "voided") return "bg-destructive/10 text-destructive border-destructive/20";
    return "bg-muted text-muted-foreground border-muted";
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
                <Select value={filter} onValueChange={(v) => setFilter(v as UiFilter)}>
                  <SelectTrigger className="w-full sm:w-56">
                    <SelectValue placeholder="Filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Orders</SelectItem>
                    <SelectItem value="wf:vendor_pending">Workflow: Pending & Expired</SelectItem>
                    <SelectItem value="wf:vendor_accepted">Workflow: Accepted</SelectItem>
                    <SelectItem value="wf:pickup_assigned">Workflow: Pickup Assigned</SelectItem>
                    <SelectItem value="wf:dispatched">Workflow: Dispatched</SelectItem>
                    
                    <SelectItem value="pay:pending">Payment: Pending</SelectItem>
                    <SelectItem value="pay:paid">Payment: Paid</SelectItem>
                    <SelectItem value="ord:open">Order: Open</SelectItem>
                    <SelectItem value="ord:closed">Order: Closed</SelectItem>
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
                  {filtered.map((o) => {
                    const wf = workflowFor(o);
                    const tl = timeLeftMs(o);

                    return (
                      <TableRow key={o.id}>
                        <TableCell className="font-medium">{o.orderNumber || o.shopifyOrderId}</TableCell>
                        <TableCell>{customerFor(o)}</TableCell>
                        <TableCell className="max-w-xs truncate">
                          {(o.lineItems || []).map((li) => `${li.title} × ${li.quantity}`).join(", ")}
                        </TableCell>
                        <TableCell className="font-semibold">{money(o.subtotal)}</TableCell>
                        <TableCell>{new Date(o.createdAt).toLocaleString()}</TableCell>

                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Badge className={workflowBadgeClass(wf)}>{workflowBadgeText(wf)}</Badge>

                            {tl ? (
                              <div className="text-xs text-muted-foreground">
                                {tl.ms > 0 ? (
                                  <>
                                    {tl.label}: <span className="font-medium">{fmtCountdown(tl.ms)}</span>
                                  </>
                                ) : (
                                  <span className="text-destructive font-semibold">Overdue</span>
                                )}
                              </div>
                            ) : null}

                            <div>
                              <Badge className={payBadgeClass(o)}>{payLabelFor(o)}</Badge>
                            </div>
                          </div>
                        </TableCell>

                        <TableCell className="text-right">
                          <Button variant="ghost" size="icon" onClick={() => handleViewOrder(o)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}

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

      {/* DETAIL DIALOG */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Order {selected?.orderNumber || selected?.shopifyOrderId}</DialogTitle>
          </DialogHeader>

          {selected ? (() => {
            const wf = workflowFor(selected);
            const tl = timeLeftMs(selected);
            
            // ✅ UNBLOCKED: Can Accept if Pending OR Expired
            const canAccept = wf === "vendor_pending" || wf === "vendor_expired";
            // Dispatch requires strict Pickup Assigned state (enforced by API)
            const canDispatch = wf === "pickup_assigned";

            return (
              <div className="space-y-5">
                {/* Top Info Grid */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Date</div>
                    <div>{new Date(selected.createdAt).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Customer</div>
                    <div>{customerFor(selected)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Workflow Status</div>
                    <div className="flex items-center gap-2">
                      <Badge className={workflowBadgeClass(wf)}>{workflowBadgeText(wf)}</Badge>
                      {tl ? (
                        <span className={`text-xs ${tl.ms > 0 ? "text-muted-foreground" : "text-destructive font-semibold"}`}>
                          {tl.ms > 0 ? `${tl.label}: ${fmtCountdown(tl.ms)}` : "Overdue"}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Payment</div>
                    <div className="flex items-center gap-2">
                      <Badge className={payBadgeClass(selected)}>{payLabelFor(selected)}</Badge>
                      <span className="text-xs text-muted-foreground">{ordLabelFor(selected)}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Amount</div>
                    <div className="font-semibold">{money(selected.subtotal)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Order ID</div>
                    <div className="text-xs">{selected.shopifyOrderId}</div>
                  </div>
                </div>

                {/* Actions Toolbar */}
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    onClick={onAcceptSelected}
                    // Only disabled if processing or if state is already advanced
                    disabled={!canAccept || actionBusy}
                    className="w-full sm:w-auto"
                  >
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Accept Order
                  </Button>

                  <Button
                    variant="outline"
                    onClick={onDispatchSelected}
                    disabled={!canDispatch || actionBusy}
                    className="w-full sm:w-auto"
                  >
                    <Truck className="h-4 w-4 mr-2" />
                    Mark Dispatched
                  </Button>

                  <Button
                    variant="outline"
                    onClick={() => downloadInvoice(selected.id, selected.invoice?.url)}
                    // Allow invoice download if URL exists (usually after acceptance)
                    disabled={!selected.invoice?.url || actionBusy}
                    className="w-full sm:w-auto"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Billing Slip
                  </Button>
                </div>

                {/* Pickup & Delivery Details (If available) */}
                {(wf === "pickup_assigned" || wf === "dispatched") && (
                  <div className="border rounded-md p-3 space-y-2 text-sm bg-muted/20">
                    <div className="font-medium flex items-center gap-2">
                      <Truck className="h-4 w-4" /> Pickup & Delivery Details
                    </div>
                    {selected.pickupPlan ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <div className="text-muted-foreground">Pickup Window</div>
                          <div>{selected.pickupPlan.pickupWindow || "—"}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Pickup Address</div>
                          <div>{selected.pickupPlan.pickupAddress || "—"}</div>
                        </div>
                        <div className="sm:col-span-2">
                          <div className="text-muted-foreground">Notes</div>
                          <div>{selected.pickupPlan.notes || "—"}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-muted-foreground">Pickup details pending.</div>
                    )}

                    {selected.deliveryPartner && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2 border-t pt-2">
                        <div>
                          <div className="text-muted-foreground">Delivery Partner</div>
                          <div>{selected.deliveryPartner.name || "—"}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Phone</div>
                          <div>{selected.deliveryPartner.phone || "—"}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">ETA</div>
                          <div>{selected.deliveryPartner.etaText || "—"}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Tracking</div>
                          {selected.deliveryPartner.trackingUrl ? (
                            <a href={selected.deliveryPartner.trackingUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                              Open Link
                            </a>
                          ) : (
                            <div>—</div>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {selected.dispatchedAt && (
                       <div className="text-xs text-muted-foreground mt-2 border-t pt-2">
                          Dispatched: {new Date(selected.dispatchedAt).toLocaleString()}
                       </div>
                    )}
                  </div>
                )}

                {/* Items Table */}
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
                              {li.sku && <div className="text-xs text-muted-foreground">SKU: {li.sku}</div>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{li.quantity}</TableCell>
                          <TableCell className="text-right">{money(li.price)}</TableCell>
                          <TableCell className="text-right">{money(li.total)}</TableCell>
                        </TableRow>
                      ))}
                      {(selected.lineItems || []).length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground">No items.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                
                <div className="text-xs text-muted-foreground">
                  Shopify Order ID: {selected.shopifyOrderId}
                </div>
              </div>
            );
          })() : null}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}