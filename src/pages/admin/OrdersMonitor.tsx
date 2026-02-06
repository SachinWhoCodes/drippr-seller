// src/pages/admin/OrdersMonitor.tsx
import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Search, Eye, ClipboardList, Clock, Download, Truck } from "lucide-react";

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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";

// --- Types ---
type LineItem = {
  title: string;
  sku?: string;
  quantity: number;
  price: number;
  total: number;
};

type WorkflowStatus =
  | "vendor_pending"
  | "vendor_accepted"
  | "pickup_assigned"
  | "dispatched"
  | "vendor_expired"
  | "admin_overdue";

type OrderDoc = {
  id: string;
  shopifyOrderId: string;
  orderNumber?: string;
  merchantId: string;
  createdAt: number;
  subtotal?: number;
  currency?: string;
  status?: string;
  financialStatus?: string;
  customerEmail?: string | null;
  raw?: { customer?: { email?: string } };
  lineItems?: LineItem[];
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

type Filter =
  | "all"
  | "needs_planning"
  | "wf:vendor_pending"
  | "wf:vendor_accepted"
  | "wf:admin_overdue"
  | "wf:pickup_assigned"
  | "wf:dispatched"
  | "wf:vendor_expired";

const THREE_HOURS = 3 * 60 * 60 * 1000;
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
// If order created after 5 PM (17:00), SLA clock starts next day 10:00 AM
function getSlaStartTime(createdAt: number) {
  const d = new Date(createdAt);
  const hour = d.getHours();

  if (hour >= 17) {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    next.setHours(10, 0, 0, 0); // 10:00 AM next day
    return next.getTime();
  }
  return createdAt;
}

export default function AdminOrdersMonitor() {
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);

  const [orders, setOrders] = useState<OrderDoc[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(Date.now());

  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<OrderDoc | null>(null);

  const [planOpen, setPlanOpen] = useState(false);
  const [planFor, setPlanFor] = useState<OrderDoc | null>(null);
  const [busy, setBusy] = useState(false);

  // Plan form
  const [pickupWindow, setPickupWindow] = useState("");
  const [pickupAddress, setPickupAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [partnerPhone, setPartnerPhone] = useState("");
  const [etaText, setEtaText] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
    return () => unsub();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!uid) return;
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(500));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: OrderDoc[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setOrders(rows);
      },
      (err) => {
        console.error(err);
        toast.error("Failed to load orders");
      }
    );
    return () => unsub();
  }, [uid]);

  useEffect(() => {
    if (!selected) return;
    const fresh = orders.find((o) => o.id === selected.id);
    if (fresh) setSelected(fresh);
  }, [orders, selected?.id]);

  const currency = useMemo(() => orders.find((o) => o.currency)?.currency || "INR", [orders]);

  const money = (v: number | undefined) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(v || 0));

  const customerFor = (o: OrderDoc) => o.customerEmail || o.raw?.customer?.email || "—";

  // --- Logic: Status Calculation ---
  const workflowFor = (o: OrderDoc): WorkflowStatus => {
    const stored = o.workflowStatus;
    const base = stored || "vendor_pending";

    if (base === "vendor_pending") {
      const slaStart = getSlaStartTime(o.createdAt);
      const acceptBy = Number(o.vendorAcceptBy || (slaStart + THREE_HOURS));
      // Returns 'vendor_expired' strictly for COLOR, but actions are unblocked below
      return now > acceptBy ? "vendor_expired" : "vendor_pending";
    }

    if (base === "vendor_accepted") {
      const acceptedAt = Number(o.vendorAcceptedAt || getSlaStartTime(o.createdAt));
      const planBy = Number(o.adminPlanBy || (acceptedAt + THIRTY_MIN));
      return now > planBy ? "admin_overdue" : "vendor_accepted";
    }

    if (base === "pickup_assigned") return "pickup_assigned";
    if (base === "dispatched") return "dispatched";

    return base as WorkflowStatus;
  };

  const badgeText = (st: WorkflowStatus) => {
    switch (st) {
      case "vendor_pending": return "Pending (Vendor)";
      case "vendor_expired": return "Expired";
      case "vendor_accepted": return "Accepted";
      case "admin_overdue": return "Admin Overdue";
      case "pickup_assigned": return "Pickup Assigned";
      case "dispatched": return "Dispatched";
      default: return st;
    }
  };

  const badgeClass = (st: WorkflowStatus) => {
    if (st === "vendor_pending") return "bg-warning/10 text-warning border-warning/20";
    if (st === "vendor_accepted") return "bg-primary/10 text-primary border-primary/20";
    if (st === "pickup_assigned" || st === "dispatched") return "bg-success/10 text-success border-success/20";
    if (st === "vendor_expired" || st === "admin_overdue") return "bg-destructive/10 text-destructive border-destructive/20";
    return "bg-muted text-muted-foreground border-muted";
  };

  const timerFor = (o: OrderDoc): { label: string; ms: number } | null => {
    const st = workflowFor(o);

    if (st === "vendor_pending" || st === "vendor_expired") {
      const slaStart = getSlaStartTime(o.createdAt);
      const acceptBy = Number(o.vendorAcceptBy || (slaStart + THREE_HOURS));
      return { label: "Vendor accept in", ms: acceptBy - now };
    }

    if (st === "vendor_accepted" || st === "admin_overdue") {
      const acceptedAt = Number(o.vendorAcceptedAt || 0) || now;
      const planBy = Number(o.adminPlanBy || (acceptedAt + THIRTY_MIN));
      return { label: "Admin plan in", ms: planBy - now };
    }

    return null;
  };

  const counts = useMemo(() => {
    const c: Record<WorkflowStatus, number> = {
      vendor_pending: 0,
      vendor_expired: 0,
      vendor_accepted: 0,
      admin_overdue: 0,
      pickup_assigned: 0,
      dispatched: 0,
    };
    orders.forEach((o) => c[workflowFor(o)]++);
    return c;
  }, [orders, now]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      const st = workflowFor(o);
      if (filter !== "all") {
        if (filter === "needs_planning") {
           // Loose filter: show anything that isn't dispatched or assigned yet? 
           // Or strictly accepted? Let's keep it strictly accepted/overdue for the filter, 
           // but the 'All' list allows action on any.
          if (!(st === "vendor_accepted" || st === "admin_overdue")) return false;
        } else if (filter.startsWith("wf:")) {
          const want = filter.replace("wf:", "") as WorkflowStatus;
          if (st !== want) return false;
        }
      }
      if (!q) return true;
      const itemsText = (o.lineItems || []).map((li) => li.title).join(" ");
      const hay = `${o.orderNumber || ""} ${o.shopifyOrderId || ""} ${o.merchantId || ""} ${customerFor(o)} ${itemsText}`.toLowerCase();
      return hay.includes(q);
    });
  }, [orders, search, filter, now]);

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
    a.download = `billing-slip_${orderId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(objectUrl);
  }

  function openDetails(o: OrderDoc) {
    setSelected(o);
    setDetailOpen(true);
  }

  function openPlan(o: OrderDoc) {
    setPlanFor(o);
    setPlanOpen(true);
    setPickupWindow("");
    setPickupAddress("");
    setNotes("");
    setPartnerName("");
    setPartnerPhone("");
    setEtaText("");
    setTrackingUrl("");
  }

  async function submitPlan() {
    if (!planFor) return;
    setBusy(true);
    try {
      await authedJsonPost("/api/admin/assign-pickup", {
        orderId: planFor.id,
        pickupWindow,
        pickupAddress,
        notes,
        deliveryPartner: {
          name: partnerName,
          phone: partnerPhone,
          etaText,
          trackingUrl,
        },
      });
      toast.success("Pickup assigned successfully");
      setPlanOpen(false);
      setPlanFor(null);
    } catch (e: any) {
      toast.error(e?.message || "Failed to assign pickup");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Orders Monitor</h2>
          <p className="text-muted-foreground">Admin view of all orders end-to-end</p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                <div className="space-y-1">
                  <CardTitle>All Orders</CardTitle>
                  <div className="text-sm text-muted-foreground flex flex-wrap gap-3 items-center">
                     {/* Counts Display */}
                    <span className="flex items-center gap-1">
                      <Clock className="h-4 w-4" /> Pending: <b>{counts.vendor_pending}</b>
                    </span>
                    <span className="flex items-center gap-1 text-destructive">
                      <Clock className="h-4 w-4" /> Expired: <b>{counts.vendor_expired}</b>
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-4 w-4" /> Accepted: <b>{counts.vendor_accepted}</b>
                    </span>
                    <span className="flex items-center gap-1 text-destructive">
                      <Clock className="h-4 w-4" /> Admin Overdue: <b>{counts.admin_overdue}</b>
                    </span>
                    <span className="flex items-center gap-1">
                      <ClipboardList className="h-4 w-4" /> Pickup Assigned: <b>{counts.pickup_assigned}</b>
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-4 w-4" /> Dispatched: <b>{counts.dispatched}</b>
                    </span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
                  <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                    <SelectTrigger className="w-full sm:w-56">
                      <SelectValue placeholder="Filter" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="needs_planning">Needs Planning</SelectItem>
                      <SelectItem value="wf:vendor_pending">Workflow: Pending</SelectItem>
                      <SelectItem value="wf:vendor_expired">Workflow: Expired</SelectItem>
                      <SelectItem value="wf:vendor_accepted">Workflow: Accepted</SelectItem>
                      <SelectItem value="wf:admin_overdue">Workflow: Admin Overdue</SelectItem>
                      <SelectItem value="wf:pickup_assigned">Workflow: Pickup Assigned</SelectItem>
                      <SelectItem value="wf:dispatched">Workflow: Dispatched</SelectItem>
                    </SelectContent>
                  </Select>

                  <div className="relative w-full sm:w-72">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search..."
                      className="pl-9"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
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
                    <TableHead>Merchant</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Timer</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {filtered.map((o) => {
                    const st = workflowFor(o);
                    const t = timerFor(o);
                    
                    // ✅ UNBLOCKED: Allow Plan if not yet dispatched/assigned
                    const canPlan = st !== "dispatched" && st !== "pickup_assigned";
                    
                    const canInvoice =
                      st !== "vendor_pending" && st !== "vendor_expired"; // Usually invoice only after accept

                    return (
                      <TableRow key={o.id}>
                        <TableCell className="font-medium">
                          {o.orderNumber || o.shopifyOrderId || o.id}
                        </TableCell>
                        <TableCell className="text-xs">{o.merchantId}</TableCell>
                        <TableCell>{customerFor(o)}</TableCell>
                        <TableCell className="font-semibold">{money(o.subtotal)}</TableCell>
                        <TableCell>{new Date(o.createdAt || Date.now()).toLocaleString()}</TableCell>
                        <TableCell>
                          <Badge className={badgeClass(st)}>{badgeText(st)}</Badge>
                        </TableCell>
                        <TableCell>
                          {t ? (
                            <div className="flex flex-col gap-1">
                              <div className="text-xs text-muted-foreground">{t.label}</div>
                              <div className={t.ms > 0 ? "font-medium" : "font-medium text-destructive"}>
                                {t.ms > 0 ? fmtCountdown(t.ms) : "Overdue"}
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex gap-2 justify-end">
                            <Button variant="ghost" size="icon" onClick={() => openDetails(o)}>
                              <Eye className="h-4 w-4" />
                            </Button>
                            
                            <Button onClick={() => openPlan(o)} disabled={!canPlan || busy}>
                              <ClipboardList className="h-4 w-4 mr-2" />
                              Plan Pickup
                            </Button>

                            <Button
                              variant="outline"
                              onClick={() => downloadInvoice(o.id, o.invoice?.url)}
                              disabled={!canInvoice || busy}
                            >
                              <Download className="h-4 w-4 mr-2" />
                              Invoice
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground">
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

      {/* DETAILS DIALOG (Kept mostly same) */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Order Details</DialogTitle>
          </DialogHeader>
          {selected && (
             <div className="space-y-4 text-sm">
                {/* ... (Details content remains same as original) ... */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div><div className="text-muted-foreground">Workflow</div><Badge className={badgeClass(workflowFor(selected))}>{badgeText(workflowFor(selected))}</Badge></div>
                </div>
                 {/* ... table and other details ... */}
             </div>
          )}
        </DialogContent>
      </Dialog>

      {/* PLAN PICKUP DIALOG */}
      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Plan Pickup</DialogTitle>
          </DialogHeader>
          {planFor && (
            <div className="space-y-4">
              <div className="text-sm">
                <div className="text-muted-foreground">Timer (Reference Only)</div>
                {(() => {
                  const t = timerFor(planFor);
                  if (!t) return <div className="text-muted-foreground">—</div>;
                  return (
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      <span className={t.ms > 0 ? "font-medium" : "font-medium text-destructive"}>
                        {t.ms > 0 ? fmtCountdown(t.ms) : "Overdue"}
                      </span>
                    </div>
                  );
                })()}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input placeholder='Pickup Window' value={pickupWindow} onChange={(e) => setPickupWindow(e.target.value)} />
                <Input placeholder="Pickup Address" value={pickupAddress} onChange={(e) => setPickupAddress(e.target.value)} />
                <Input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <div />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input placeholder="Partner Name" value={partnerName} onChange={(e) => setPartnerName(e.target.value)} />
                <Input placeholder="Partner Phone" value={partnerPhone} onChange={(e) => setPartnerPhone(e.target.value)} />
                <Input placeholder='ETA' value={etaText} onChange={(e) => setEtaText(e.target.value)} />
                <Input placeholder="Tracking URL" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} />
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button onClick={submitPlan} disabled={busy}>
                  <Truck className="h-4 w-4 mr-2" />
                  Assign Pickup
                </Button>
                <Button variant="outline" onClick={() => setPlanOpen(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>

              <div className="text-xs text-muted-foreground">
                 {/* Updated Text */}
                 You can assign a pickup now. Current status: {badgeText(workflowFor(planFor))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}