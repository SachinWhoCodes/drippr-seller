// api/orders/invoice.ts
import { getAdmin } from "../_lib/firebaseAdmin.js";
import { getAuth } from "firebase-admin/auth";

function toAsciiSafe(input: any): string {
  const s = String(input ?? "");
  // Replace non-ASCII with '?', keep it simple for standard PDF fonts
  return s.replace(/[^\x20-\x7E]/g, "?");
}

function pdfEscape(text: string): string {
  // Escape backslash and parentheses for PDF string literals
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSimplePdf(lines: string[]): Buffer {
  // Minimal single-page PDF with Helvetica
  // Page size: A4 (595 x 842)
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");

  // Build content stream (text)
  const safeLines = lines.map((l) => pdfEscape(toAsciiSafe(l)));

  // Layout
  const startX = 50;
  const startY = 800;
  const fontSize = 12;
  const lineGap = 16;

  // Build text operators
  // Using relative moves via Td
  let content = "BT\n/F1 " + fontSize + " Tf\n";
  content += `${startX} ${startY} Td\n`;

  safeLines.forEach((l, idx) => {
    content += `(${l}) Tj\n`;
    if (idx !== safeLines.length - 1) content += `0 -${lineGap} Td\n`;
  });

  content += "ET\n";

  const contentBytes = Buffer.from(content, "utf8");

  // PDF objects (as ASCII strings)
  const objs: Buffer[] = [];

  const pushObj = (n: number, body: Buffer) => {
    objs.push(Buffer.from(`${n} 0 obj\n`, "utf8"));
    objs.push(body);
    objs.push(Buffer.from("\nendobj\n", "utf8"));
  };

  // 1) Catalog
  pushObj(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "utf8"));

  // 2) Pages
  pushObj(2, Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "utf8"));

  // 3) Page
  pushObj(
    3,
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "utf8"
    )
  );

  // 4) Font
  pushObj(4, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "utf8"));

  // 5) Contents stream
  const streamHeader = Buffer.from(`<< /Length ${contentBytes.length} >>\nstream\n`, "utf8");
  const streamFooter = Buffer.from("\nendstream", "utf8");
  const contentsObjBody = Buffer.concat([streamHeader, contentBytes, streamFooter]);
  pushObj(5, contentsObjBody);

  // Now assemble with xref offsets
  const parts: Buffer[] = [header];

  const offsets: number[] = [0]; // object 0 is special
  let offset = header.length;

  // We need offsets for each object start (1..5). Our pushObj writes 3 buffers per object.
  // We reconstruct object boundaries by scanning for "n 0 obj\n" boundaries in the assembled buffers.
  // Easier: build object strings in a single buffer per object.
  // We'll do that now:

  const objectBuffers: Buffer[] = [];

  // Rebuild objects as single buffers for accurate offsets
  const obj1 = Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "utf8");
  const obj2 = Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "utf8");
  const obj3 = Buffer.from(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "utf8"
  );
  const obj4 = Buffer.from("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n", "utf8");
  const obj5 = Buffer.concat([
    Buffer.from("5 0 obj\n", "utf8"),
    contentsObjBody,
    Buffer.from("\nendobj\n", "utf8"),
  ]);

  objectBuffers.push(obj1, obj2, obj3, obj4, obj5);

  offsets.length = 1; // reset, keep 0th
  offset = header.length;

  for (const ob of objectBuffers) {
    offsets.push(offset);
    parts.push(ob);
    offset += ob.length;
  }

  const xrefStart = offset;

  // xref table
  let xref = "xref\n0 6\n";
  xref += "0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    const off = offsets[i];
    xref += String(off).padStart(10, "0") + " 00000 n \n";
  }

  const trailer =
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n";

  parts.push(Buffer.from(xref, "utf8"));
  parts.push(Buffer.from(trailer, "utf8"));

  return Buffer.concat(parts);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { adminDb } = getAdmin();

    // --- Auth required ---
    const authHeader = String(req.headers.authorization || "");
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const idToken = match?.[1];
    if (!idToken) {
      return res.status(401).json({ ok: false, error: "Missing Authorization Bearer token" });
    }

    let uid = "";
    let isAdmin = false;
    try {
      const decoded: any = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
      // support common patterns for admin claims
      isAdmin = decoded.admin === true || decoded.isAdmin === true || decoded.role === "admin";
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    const orderId = String(req.query?.orderId || "").trim();
    if (!orderId) return res.status(400).json({ ok: false, error: "Missing orderId" });

    const snap = await adminDb.collection("orders").doc(orderId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Order not found" });

    const o = snap.data() as any;

    // Security: only merchant owner or admin
    const merchantId = String(o.merchantId || "");
    if (!isAdmin && merchantId !== uid) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const workflowStatus = String(o.workflowStatus || "vendor_pending");
    const allowed = ["vendor_accepted", "pickup_assigned", "dispatched"].includes(workflowStatus);
    if (!allowed) {
      return res.status(409).json({ ok: false, error: "Invoice available after vendor acceptance" });
    }

    const orderNumber = o.orderNumber || o.shopifyOrderId || orderId;
    const createdAt = Number(o.createdAt || Date.now());
    const acceptedAt = Number(o.vendorAcceptedAt || 0) || null;
    const currency = o.currency || "INR";
    const subtotal = Number(o.subtotal || 0);

    const customerEmail =
      o.customerEmail || o.raw?.customer?.email || o.raw?.customerEmail || "—";

    const items = Array.isArray(o.lineItems) ? o.lineItems : [];
    const itemLines =
      items.length > 0
        ? items.map((li: any, i: number) => {
            const title = li?.title || "Item";
            const qty = Number(li?.quantity || 0);
            const price = Number(li?.price || 0);
            return `${i + 1}. ${title} | Qty: ${qty} | Unit: ${price.toFixed(2)} ${currency}`;
          })
        : ["No items"];

    const lines: string[] = [
      "BILLING SLIP",
      "----------------------------------------",
      `Order: ${orderNumber}`,
      `Order ID: ${String(o.shopifyOrderId || "")}`,
      `Merchant ID: ${merchantId}`,
      `Customer: ${customerEmail}`,
      `Created: ${new Date(createdAt).toLocaleString()}`,
      acceptedAt ? `Accepted: ${new Date(acceptedAt).toLocaleString()}` : "Accepted: —",
      "----------------------------------------",
      "Items:",
      ...itemLines,
      "----------------------------------------",
      `Subtotal: ${subtotal.toFixed(2)} ${currency}`,
      `Payment: ${String(o.financialStatus || "pending")}`,
      `Order State: ${String(o.status || "open")}`,
      `Workflow: ${workflowStatus}`,
      "----------------------------------------",
      "This slip is system-generated.",
    ];

    const pdf = buildSimplePdf(lines);

    const filename = `billing-slip_${toAsciiSafe(orderNumber).replace(/[^A-Za-z0-9_-]+/g, "_")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.status(200).send(pdf);
  } catch (err: any) {
    console.error("orders/invoice error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

