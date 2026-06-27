// ============================================================================
// Rushroom Compliance Portal — API gateway (Supabase Edge Function)
//
// The browser talks ONLY to this function; it never touches the database or
// storage directly. This function authenticates the role password server-side,
// issues a short-lived signed token, and enforces what each role may do:
//   • rushroom — read everything, edit any step, upload, list uploads
//   • supplier — read only supplier-tagged steps/docs, edit status of those
//                steps, upload files
//
// Required Edge Function secrets (Project → Edge Functions → Manage secrets):
//   RUSHROOM_PW_HASH  SHA-256 hex of the Rushroom password
//   SUPPLIER_PW_HASH  SHA-256 hex of the supplier password
//   TOKEN_SECRET      any long random string (signs session tokens)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Deploy with JWT verification OFF (we do our own auth):
//   supabase functions deploy portal-api --no-verify-jwt
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "supplier-uploads";
const DOC_BUCKET = "documents";
const TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN_SECRET = Deno.env.get("TOKEN_SECRET") ?? "";
const PW_HASH: Record<string, string | undefined> = {
  rushroom: Deno.env.get("RUSHROOM_PW_HASH")?.toLowerCase(),
  supplier: Deno.env.get("SUPPLIER_PW_HASH")?.toLowerCase(),
};

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const enc = new TextEncoder();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---- crypto helpers --------------------------------------------------------
// Copy any view into a standalone ArrayBuffer so Web Crypto's BufferSource
// param types are satisfied (avoids the SharedArrayBuffer/ArrayBufferLike clash).
function ab(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", ab(enc.encode(text))));
}
async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ab(enc.encode(TOKEN_SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
// Constant-time-ish compare
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function issueToken(role: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), ab(enc.encode(payload)))));
  return `${payload}.${sig}`;
}
async function verifyToken(token: string | undefined): Promise<string | null> {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), ab(b64urlDecode(sig)), ab(enc.encode(payload)));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.role === "rushroom" || data.role === "supplier" ? data.role : null;
  } catch {
    return null;
  }
}

const isSupplierStep = (audience: string[] | null) => Array.isArray(audience) && audience.includes("supplier");
const safeName = (n: string) => (n || "file").replace(/[^\w.\-]+/g, "_").slice(-120);

// ---- request handler -------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!TOKEN_SECRET) return json({ error: "Server not configured (TOKEN_SECRET missing)" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body.action || "");

  // --- login: password -> token -------------------------------------------
  if (action === "login") {
    const role = body.role === "rushroom" || body.role === "supplier" ? body.role : null;
    const expected = role ? PW_HASH[role] : undefined;
    if (!role || !expected) return json({ error: "Unknown role" }, 400);
    const got = await sha256Hex(String(body.password ?? ""));
    if (!eq(got, expected)) return json({ error: "Incorrect password" }, 401);
    return json({ token: await issueToken(role), role });
  }

  // --- everything else requires a valid token -----------------------------
  const role = await verifyToken(body.token);
  if (!role) return json({ error: "Not authenticated" }, 401);

  if (action === "data") {
    const [{ data: steps }, { data: documents }] = await Promise.all([
      db.from("steps").select("*").order("step"),
      db.from("documents").select("*").order("sort").order("category"),
    ]);
    const s = role === "supplier" ? (steps ?? []).filter((r) => isSupplierStep(r.audience)) : (steps ?? []);
    const d = role === "supplier" ? (documents ?? []).filter((r) => isSupplierStep(r.audience)) : (documents ?? []);
    // Attach an "open" link: a short-lived signed URL for files stored here, or
    // the external URL for legacy/Drive-linked documents.
    const docs = await Promise.all(d.map(async (doc) => {
      if (doc.storage_path) {
        const { data: signed } = await db.storage.from(DOC_BUCKET).createSignedUrl(doc.storage_path, 60 * 60);
        return { ...doc, open_url: signed?.signedUrl ?? "" };
      }
      return { ...doc, open_url: doc.url || "" };
    }));
    return json({ role, steps: s, documents: docs });
  }

  if (action === "setStatus") {
    const step = Number(body.step);
    const status = String(body.status ?? "").trim();
    if (!step || !status) return json({ error: "step and status required" }, 400);
    const { data: row } = await db.from("steps").select("audience").eq("step", step).maybeSingle();
    if (!row) return json({ error: "Unknown step" }, 404);
    if (role === "supplier" && !isSupplierStep(row.audience)) return json({ error: "Not allowed for this step" }, 403);
    const by = role === "supplier" ? `supplier${body.supplierLabel ? ` (${String(body.supplierLabel).slice(0, 60)})` : ""}` : "rushroom";
    const { error } = await db.from("steps").update({ status, updated_at: new Date().toISOString(), updated_by: by }).eq("step", step);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, step, status });
  }

  if (action === "uploadUrl") {
    const path = `${role}/${Date.now()}-${safeName(String(body.fileName ?? "file"))}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ signedUrl: data.signedUrl, token: data.token, path });
  }

  if (action === "recordUpload") {
    const path = String(body.path ?? "");
    const fileName = String(body.fileName ?? "");
    if (!path || !fileName) return json({ error: "path and fileName required" }, 400);
    const { error } = await db.from("uploads").insert({
      step: body.step ? Number(body.step) : null,
      uploaded_role: role,
      supplier_label: String(body.supplierLabel ?? "").slice(0, 120),
      file_path: path,
      file_name: fileName.slice(0, 200),
      note: String(body.note ?? "").slice(0, 500),
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // --- document library management (Rushroom only) ------------------------
  if (action === "docUploadUrl") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const path = `${Date.now()}-${safeName(String(body.fileName ?? "file"))}`;
    const { data, error } = await db.storage.from(DOC_BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ signedUrl: data.signedUrl, token: data.token, path });
  }

  if (action === "addDocument") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "name required" }, 400);
    const audience = Array.isArray(body.audience) && body.audience.length
      ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    const { error } = await db.from("documents").insert({
      category: (String(body.category ?? "").trim() || "Uncategorised").slice(0, 80),
      name: name.slice(0, 200),
      url: String(body.url ?? "").slice(0, 1000),
      storage_path: String(body.storagePath ?? "").slice(0, 400),
      audience,
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "deleteDocument") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: doc } = await db.from("documents").select("storage_path").eq("id", id).maybeSingle();
    if (doc?.storage_path) await db.storage.from(DOC_BUCKET).remove([doc.storage_path]);
    const { error } = await db.from("documents").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "uploads") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const { data, error } = await db.from("uploads").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) return json({ error: error.message }, 500);
    // Attach short-lived signed download links
    const withUrls = await Promise.all((data ?? []).map(async (u) => {
      const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(u.file_path, 60 * 30);
      return { ...u, download_url: signed?.signedUrl ?? "" };
    }));
    return json({ uploads: withUrls });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
