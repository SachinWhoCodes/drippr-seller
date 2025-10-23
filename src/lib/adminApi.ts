import { QueueProduct, Merchant, SupportTicket, AdminOverview } from "@/types/admin";

// Stub for now - always returns true
export function useIsAdmin() {
  return true;
}

// Mock data
const mockQueueProducts: QueueProduct[] = [
  {
    id: "prod_001",
    merchantId: "merchant_001",
    title: "Premium Cotton T-Shirt",
    description: "High-quality cotton t-shirt with premium finish",
    image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400",
    images: [
      "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400",
      "https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?w=400"
    ],
    price: 799,
    productType: "Apparel",
    status: "in_review",
    published: false,
    tags: ["cotton", "casual", "summer"],
    createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    variantDraft: {
      options: [
        { name: "Size", values: ["S", "M", "L", "XL"] },
        { name: "Color", values: ["Black", "White", "Saffron"] }
      ],
      variants: [
        { optionValues: ["S", "Black"], price: 799, compareAtPrice: 999, sku: "TSH-S-BLK", quantity: 50, barcode: "123456789", weightGrams: 200 },
        { optionValues: ["S", "White"], price: 799, compareAtPrice: 999, sku: "TSH-S-WHT", quantity: 45, barcode: "123456790", weightGrams: 200 },
        { optionValues: ["M", "Black"], price: 799, compareAtPrice: 999, sku: "TSH-M-BLK", quantity: 60, barcode: "123456791", weightGrams: 220 },
        { optionValues: ["L", "Saffron"], price: 799, compareAtPrice: 999, sku: "TSH-L-SAF", quantity: 40, barcode: "123456792", weightGrams: 240 }
      ]
    },
    merchant: { name: "Fashion Hub", email: "fashion@example.com" }
  },
  {
    id: "prod_002",
    merchantId: "merchant_002",
    title: "Wireless Bluetooth Earbuds",
    description: "Premium sound quality with noise cancellation",
    image: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400",
    images: ["https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400"],
    price: 2499,
    productType: "Electronics",
    status: "in_review",
    published: false,
    tags: ["electronics", "audio", "wireless"],
    createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
    merchant: { name: "Tech Store", email: "tech@example.com" }
  },
  {
    id: "prod_003",
    merchantId: "merchant_003",
    title: "Leather Wallet",
    description: "Genuine leather wallet with RFID protection",
    image: "https://images.unsplash.com/photo-1627123424574-724758594e93?w=400",
    images: ["https://images.unsplash.com/photo-1627123424574-724758594e93?w=400"],
    price: 1299,
    productType: "Accessories",
    status: "draft",
    published: false,
    tags: ["leather", "wallet", "accessories"],
    createdAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
    merchant: { name: "Leather Craft", email: "leather@example.com" }
  },
  {
    id: "prod_004",
    merchantId: "merchant_004",
    title: "Yoga Mat Premium",
    description: "Anti-slip yoga mat with carrying strap",
    image: "https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=400",
    images: ["https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=400"],
    price: 1599,
    productType: "Sports",
    status: "active",
    published: true,
    tags: ["yoga", "fitness", "sports"],
    createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    merchant: { name: "Fitness Pro", email: "fitness@example.com" }
  },
  {
    id: "prod_005",
    merchantId: "merchant_005",
    title: "Ceramic Coffee Mug Set",
    description: "Set of 4 handcrafted ceramic mugs",
    image: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=400",
    images: ["https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=400"],
    price: 899,
    productType: "Home & Kitchen",
    status: "rejected",
    published: false,
    tags: ["ceramic", "kitchen", "handmade"],
    createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
    adminNotes: "Product images quality is poor. Please submit better images.",
    merchant: { name: "Home Essentials", email: "home@example.com" }
  }
];

const mockMerchants: Merchant[] = [
  {
    uid: "merchant_001",
    email: "fashion@example.com",
    name: "Rajesh Kumar",
    phone: "+91 98765 43210",
    storeName: "Fashion Hub",
    businessCategory: "Apparel",
    gstin: "27AABCU9603R1ZM",
    address: "123 MG Road, Mumbai, Maharashtra",
    enabled: true,
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000
  },
  {
    uid: "merchant_002",
    email: "tech@example.com",
    name: "Priya Sharma",
    phone: "+91 98765 43211",
    storeName: "Tech Store",
    businessCategory: "Electronics",
    gstin: "29AABCU9603R1ZN",
    address: "456 Brigade Road, Bangalore, Karnataka",
    enabled: true,
    createdAt: Date.now() - 120 * 24 * 60 * 60 * 1000
  },
  {
    uid: "merchant_003",
    email: "leather@example.com",
    name: "Amit Patel",
    phone: "+91 98765 43212",
    storeName: "Leather Craft",
    businessCategory: "Accessories",
    gstin: "24AABCU9603R1ZO",
    address: "789 CG Road, Ahmedabad, Gujarat",
    enabled: false,
    createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000
  },
  {
    uid: "merchant_004",
    email: "fitness@example.com",
    name: "Sneha Singh",
    phone: "+91 98765 43213",
    storeName: "Fitness Pro",
    businessCategory: "Sports & Fitness",
    gstin: "07AABCU9603R1ZP",
    address: "321 Connaught Place, New Delhi",
    enabled: true,
    createdAt: Date.now() - 150 * 24 * 60 * 60 * 1000
  },
  {
    uid: "merchant_005",
    email: "home@example.com",
    name: "Vikram Reddy",
    phone: "+91 98765 43214",
    storeName: "Home Essentials",
    businessCategory: "Home & Kitchen",
    gstin: "36AABCU9603R1ZQ",
    address: "654 Jubilee Hills, Hyderabad, Telangana",
    enabled: true,
    createdAt: Date.now() - 45 * 24 * 60 * 60 * 1000
  }
];

const mockSupportTickets: SupportTicket[] = [
  {
    id: "ticket_001",
    merchantId: "merchant_001",
    subject: "Payment not received for Order #12345",
    message: "I haven't received payment for my order placed 5 days ago. Please help.",
    category: "payment",
    priority: "high",
    status: "pending",
    email: "fashion@example.com",
    name: "Rajesh Kumar",
    createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
    timeline: [
      { at: Date.now() - 1 * 24 * 60 * 60 * 1000, by: "merchant", type: "created", note: "Ticket created" }
    ]
  },
  {
    id: "ticket_002",
    merchantId: "merchant_002",
    subject: "How to add product variants?",
    message: "I need help understanding how to add size and color variants to my products.",
    category: "product",
    priority: "medium",
    status: "processing",
    email: "tech@example.com",
    name: "Priya Sharma",
    createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    timeline: [
      { at: Date.now() - 3 * 24 * 60 * 60 * 1000, by: "merchant", type: "created", note: "Ticket created" },
      { at: Date.now() - 2 * 24 * 60 * 60 * 1000, by: "admin", type: "status", note: "Status changed to processing" },
      { at: Date.now() - 2 * 24 * 60 * 60 * 1000, by: "admin", type: "message", note: "We'll send you a detailed guide shortly." }
    ]
  },
  {
    id: "ticket_003",
    merchantId: "merchant_003",
    subject: "Account suspended without reason",
    message: "My account was suspended. I need to know the reason and how to resolve this.",
    category: "account",
    priority: "critical",
    status: "processing",
    email: "leather@example.com",
    name: "Amit Patel",
    createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    timeline: [
      { at: Date.now() - 2 * 24 * 60 * 60 * 1000, by: "merchant", type: "created", note: "Ticket created" },
      { at: Date.now() - 1 * 24 * 60 * 60 * 1000, by: "admin", type: "status", note: "Status changed to processing" }
    ]
  },
  {
    id: "ticket_004",
    merchantId: "merchant_004",
    subject: "Website loading slow",
    message: "The seller dashboard is loading very slowly since yesterday.",
    category: "technical",
    priority: "medium",
    status: "resolved",
    email: "fitness@example.com",
    name: "Sneha Singh",
    createdAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
    timeline: [
      { at: Date.now() - 5 * 24 * 60 * 60 * 1000, by: "merchant", type: "created", note: "Ticket created" },
      { at: Date.now() - 4 * 24 * 60 * 60 * 1000, by: "admin", type: "status", note: "Status changed to processing" },
      { at: Date.now() - 3 * 24 * 60 * 60 * 1000, by: "admin", type: "message", note: "We've optimized the servers. Please check now." },
      { at: Date.now() - 3 * 24 * 60 * 60 * 1000, by: "admin", type: "status", note: "Status changed to resolved" }
    ]
  },
  {
    id: "ticket_005",
    merchantId: "merchant_005",
    subject: "Need help with order cancellation",
    message: "Customer wants to cancel order but option is not showing.",
    category: "order",
    priority: "low",
    status: "pending",
    email: "home@example.com",
    name: "Vikram Reddy",
    createdAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
    timeline: [
      { at: Date.now() - 4 * 24 * 60 * 60 * 1000, by: "merchant", type: "created", note: "Ticket created" }
    ]
  }
];

// API Functions
export async function adminMe(): Promise<{ ok: true; isAdmin: true }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ ok: true, isAdmin: true });
    }, 300);
  });
}

export async function listQueueProducts(params: {
  status?: string;
  q?: string;
  cursor?: string;
}): Promise<{ ok: true; items: QueueProduct[] }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      let filtered = [...mockQueueProducts];

      if (params.status && params.status !== "all") {
        filtered = filtered.filter((p) => p.status === params.status);
      }

      if (params.q) {
        const query = params.q.toLowerCase();
        filtered = filtered.filter(
          (p) =>
            p.title.toLowerCase().includes(query) ||
            p.merchant?.name?.toLowerCase().includes(query)
        );
      }

      resolve({ ok: true, items: filtered });
    }, 400);
  });
}

export async function approveProduct(id: string): Promise<{ ok: true }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const product = mockQueueProducts.find((p) => p.id === id);
      if (product) {
        product.status = "active";
        product.published = true;
      }
      resolve({ ok: true });
    }, 500);
  });
}

export async function rejectProduct(
  id: string,
  reason: string
): Promise<{ ok: true }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const product = mockQueueProducts.find((p) => p.id === id);
      if (product) {
        product.status = "rejected";
        product.adminNotes = reason;
      }
      resolve({ ok: true });
    }, 500);
  });
}

export async function listMerchants(params: {
  q?: string;
  cursor?: string;
}): Promise<{ ok: true; items: Merchant[] }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      let filtered = [...mockMerchants];

      if (params.q) {
        const query = params.q.toLowerCase();
        filtered = filtered.filter(
          (m) =>
            m.name?.toLowerCase().includes(query) ||
            m.email?.toLowerCase().includes(query) ||
            m.storeName?.toLowerCase().includes(query)
        );
      }

      resolve({ ok: true, items: filtered });
    }, 350);
  });
}

export async function updateMerchant(
  uid: string,
  patch: Partial<Merchant>
): Promise<{ ok: true }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const merchant = mockMerchants.find((m) => m.uid === uid);
      if (merchant) {
        Object.assign(merchant, patch);
      }
      resolve({ ok: true });
    }, 400);
  });
}

export async function listSupport(params: {
  status?: string;
  q?: string;
  cursor?: string;
}): Promise<{ ok: true; items: SupportTicket[] }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      let filtered = [...mockSupportTickets];

      if (params.status && params.status !== "all") {
        filtered = filtered.filter((t) => t.status === params.status);
      }

      if (params.q) {
        const query = params.q.toLowerCase();
        filtered = filtered.filter(
          (t) =>
            t.subject.toLowerCase().includes(query) ||
            t.name?.toLowerCase().includes(query)
        );
      }

      resolve({ ok: true, items: filtered });
    }, 400);
  });
}

export async function replySupport(
  id: string,
  message: string,
  newStatus?: "processing" | "resolved"
): Promise<{ ok: true }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const ticket = mockSupportTickets.find((t) => t.id === id);
      if (ticket) {
        ticket.timeline.push({
          at: Date.now(),
          by: "admin",
          type: "message",
          note: message,
        });
        if (newStatus) {
          ticket.status = newStatus;
          ticket.timeline.push({
            at: Date.now(),
            by: "admin",
            type: "status",
            note: `Status changed to ${newStatus}`,
          });
        }
      }
      resolve({ ok: true });
    }, 450);
  });
}

export async function adminOverview(): Promise<{ ok: true; data: AdminOverview }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const last30Days = Array.from({ length: 30 }, (_, i) => {
        const date = new Date();
        date.setDate(date.getDate() - (29 - i));
        return date.toISOString().split("T")[0];
      });

      const ordersSeries = last30Days.map((day, idx) => ({
        day: day.split("-").slice(1).join("/"),
        orders: Math.floor(Math.random() * 50) + 20,
      }));

      const revenueSeries = last30Days.map((day, idx) => ({
        day: day.split("-").slice(1).join("/"),
        revenue: Math.floor(Math.random() * 50000) + 10000,
      }));

      const data: AdminOverview = {
        productsInReview: mockQueueProducts.filter((p) => p.status === "in_review")
          .length,
        activeSellers: mockMerchants.filter((m) => m.enabled).length,
        openTickets: mockSupportTickets.filter((t) => t.status === "pending").length,
        mtdOrders: ordersSeries.reduce((sum, s) => sum + s.orders, 0),
        mtdRevenue: revenueSeries.reduce((sum, s) => sum + s.revenue, 0),
        ordersSeries,
        revenueSeries,
      };

      resolve({ ok: true, data });
    }, 600);
  });
}

// Settings (localStorage)
export function getLocalPublicationId(): string | null {
  return localStorage.getItem("admin_publication_id");
}

export function setLocalPublicationId(v: string): void {
  localStorage.setItem("admin_publication_id", v);
}
