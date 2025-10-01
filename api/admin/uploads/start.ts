// /api/admin/uploads/start.ts
import { adminAuth } from "../../_lib/firebaseAdmin.js";
import { shopifyGraphQL } from "../../_lib/shopify.js";

const STAGED_UPLOADS_CREATE = `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters { name value }
    }
    userErrors { field message }
  }
}
`;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // 1) Verify Firebase ID token (caller must be logged in)
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Missing Authorization" });
    await adminAuth.verifyIdToken(token);

    // 2) Expect files metadata: [{ filename, mimeType, fileSize }]
    const { files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, error: "No files provided" });
    }

    // 3) Build inputs for Shopify staged uploads
    const input = files.map((f: any) => ({
      resource: "IMAGE",
      filename: f.filename,
      mimeType: f.mimeType,
      fileSize: Number(f.fileSize),
      httpMethod: "POST",
    }));

    const r = await shopifyGraphQL(STAGED_UPLOADS_CREATE, { input });
    const targets = r.data.stagedUploadsCreate.stagedTargets;

    return res.status(200).json({ ok: true, targets });
  } catch (e: any) {
    console.error("uploads/start error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Internal error" });
  }
}
