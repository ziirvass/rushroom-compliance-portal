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
import * as JSZipNS from "https://esm.sh/jszip@3.10.1";
// jszip ships an export-assignment type (no default export); unwrap for Deno.
const JSZip: any = (JSZipNS as any).default ?? JSZipNS;

const BUCKET = "supplier-uploads";
const DOC_BUCKET = "documents";
const STD_BUCKET = "standards";
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

// A session token carries the access tier (role) + admin flag + user identity.
async function issueSession(payload: Record<string, unknown>): Promise<string> {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const p = b64url(enc.encode(JSON.stringify(body)));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), ab(enc.encode(p)))));
  return `${p}.${sig}`;
}
async function verifySession(token: string | undefined): Promise<any | null> {
  if (!token || !token.includes(".")) return null;
  const [p, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), ab(b64urlDecode(sig)), ab(enc.encode(p)));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (data.role !== "rushroom" && data.role !== "supplier") return null;
    return data;
  } catch { return null; }
}

// ---- password hashing (PBKDF2-SHA256) --------------------------------------
async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", ab(enc.encode(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: ab(salt), iterations: 120000, hash: "SHA-256" }, key, 256);
  return `pbkdf2$120000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}
async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, iterStr, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2" || !saltB64 || !hashB64) return false;
  const salt = b64urlDecode(saltB64);
  const key = await crypto.subtle.importKey("raw", ab(enc.encode(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: ab(salt), iterations: Number(iterStr) || 120000, hash: "SHA-256" }, key, 256);
  return eq(b64url(new Uint8Array(bits)), hashB64);
}

const isSupplierStep = (audience: string[] | null) => Array.isArray(audience) && audience.includes("supplier");
const safeName = (n: string) => (n || "file").replace(/[^\w.\-]+/g, "_").slice(-120);

// ---- user accounts: registration, verification, admin --------------------
const APP_BASE = (Deno.env.get("APP_BASE_URL") ?? "https://ziirvass.github.io/rushroom-compliance-portal").replace(/\/+$/, "");
const USER_ROLES = ["supplier", "reviewer", "installer", "internal"]; // roles a user may REQUEST at registration
const ASSIGNABLE_ROLES = ["admin", "internal", "reviewer", "supplier", "installer"]; // roles an admin may ASSIGN
const USER_STATUSES = ["pending", "verified", "approved", "rejected", "disabled"];
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
// Map an assigned user role to an access tier the portal enforces.
// Full-access roles see everything; supplier/installer get the limited view.
const roleTier = (r: string): "rushroom" | "supplier" =>
  ["admin", "internal", "reviewer"].includes(r) ? "rushroom" : "supplier";

// HMAC-sign an arbitrary payload (used for email-verification links).
async function signData(obj: unknown): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(obj)));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), ab(enc.encode(payload)))));
  return `${payload}.${sig}`;
}
async function readSigned(token: string): Promise<any | null> {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), ab(b64urlDecode(sig)), ab(enc.encode(payload)));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch { return null; }
}
const verifyLinkFor = async (uid: string) =>
  `${APP_BASE}/verify.html?token=${encodeURIComponent(await signData({ uid, purpose: "verify", exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 }))}`;
const resetLinkFor = async (uid: string) =>
  `${APP_BASE}/reset.html?token=${encodeURIComponent(await signData({ uid, purpose: "setpw", exp: Math.floor(Date.now() / 1000) + 3600 }))}`;

// Best-effort transactional email via Resend (optional — set RESEND_API_KEY).
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  const from = Deno.env.get("MAIL_FROM") || "Rushroom Compliance <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return res.ok;
  } catch { return false; }
}
const sendVerificationEmail = (to: string, name: string, url: string) =>
  sendEmail(to, "Verify your Rushroom Compliance Portal registration",
    `<p>Hi ${name || "there"},</p><p>Thanks for registering for the Rushroom AB Compliance Portal. Please confirm your email address:</p><p><a href="${url}">Verify my email</a></p><p>This link expires in 7 days. If you didn't request this, you can ignore it.</p>`);
const sendPasswordEmail = (to: string, name: string, url: string) =>
  sendEmail(to, "Set your Rushroom Compliance Portal password",
    `<p>Hi ${name || "there"},</p><p>Use the link below to set a new password for the Rushroom AB Compliance Portal:</p><p><a href="${url}">Set my password</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore it.</p>`);

// ---- AI deviation monitoring (Claude) ----
// Insert a document_versions row, tolerating the optional provenance columns
// (source_document_version_id / source_standard_version_ids) not existing yet —
// if the DB doesn't have them, retry without them so publishing still works.
async function insertDocumentVersion(row: Record<string, unknown>) {
  // Auto-number the version (v1, v2, v3 …) when no label was supplied.
  if (!String(row.version ?? "").trim() && row.document_id) {
    const { count } = await db.from("document_versions").select("id", { count: "exact", head: true }).eq("document_id", row.document_id as string);
    row.version = `v${(count ?? 0) + 1}`;
  }
  let res = await db.from("document_versions").insert(row);
  if (res.error && /source_(document|standard)_version_ids?/.test(res.error.message || "")) {
    const clean = { ...row };
    delete clean.source_document_version_id;
    delete clean.source_standard_version_ids;
    res = await db.from("document_versions").insert(clean);
  }
  return res;
}

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SCAN_MODEL = "claude-opus-4-8";
// Token usage from a Claude response — surfaced in the UI so the team can see
// how much AI each operation costs (front-end turns tokens into an estimate).
const usageOf = (j: any) => ({
  model: j?.model || SCAN_MODEL,
  input_tokens: j?.usage?.input_tokens ?? 0,
  output_tokens: j?.usage?.output_tokens ?? 0,
  cache_read_input_tokens: j?.usage?.cache_read_input_tokens ?? 0,
});
const addUsage = (a: any, b: any) => ({
  model: a.model || b?.model || SCAN_MODEL,
  input_tokens: (a.input_tokens || 0) + (b?.input_tokens ?? 0),
  output_tokens: (a.output_tokens || 0) + (b?.output_tokens ?? 0),
  cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b?.cache_read_input_tokens ?? 0),
});
const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"];
const TEXT_CAP = 40000; // per-file char cap fed to the model
const DOCUMENT_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    proposed_changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["title", "description", "rationale"],
      },
    },
    draft_text: { type: "string" },
    version_hint: { type: "string" },
    file_name_hint: { type: "string" },
  },
  required: ["summary", "proposed_changes", "draft_text", "version_hint", "file_name_hint"],
};
const STANDARD_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    title: { type: "string" },
    category: { type: "string" },
    reg_type: { type: "string" },
    jurisdiction: { type: "string" },
    version: { type: "string" },
    effective_date: { type: "string" },
    summary: { type: "string" },
  },
  required: ["code", "title", "category", "reg_type", "jurisdiction", "version", "effective_date", "summary"],
};
const FILE_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    category: { type: "string" },
    version: { type: "string" },
    effective_date: { type: "string" },
    kind: { type: "string" },
    summary: { type: "string" },
  },
  required: ["name", "category", "version", "effective_date", "kind", "summary"],
};
const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          title: { type: "string" },
          description: { type: "string" },
          document: { type: "string" },
          standard: { type: "string" },
          recommendation: { type: "string" },
        },
        required: ["severity", "title", "description", "document", "standard", "recommendation"],
      },
    },
  },
  required: ["summary", "findings"],
};

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}
async function extractDocx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const withBreaks = xml.replace(/<w:p[ >/]/g, "\n<w:p ").replace(/<[^>]+>/g, " ");
  return xmlDecode(withBreaks).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}
async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const shared = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const cells = [...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1]).trim()).filter(Boolean);
  return cells.join(" · ");
}
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
// Returns a Claude content block for a stored file.
async function fileBlock(bucket: string, path: string, fileName: string) {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) return { type: "text", text: "(could not read file)" };
  const bytes = new Uint8Array(await data.arrayBuffer());
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  try {
    if (ext === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(bytes) } };
    if (ext === "docx") return { type: "text", text: (await extractDocx(bytes)).slice(0, TEXT_CAP) || "(empty)" };
    if (ext === "xlsx" || ext === "xls") return { type: "text", text: (await extractXlsx(bytes)).slice(0, TEXT_CAP) || "(empty)" };
    return { type: "text", text: new TextDecoder().decode(bytes).slice(0, TEXT_CAP) || "(empty)" };
  } catch (e) {
    return { type: "text", text: `(could not extract text: ${(e as Error).message})` };
  }
}

async function summarizeRequirementSource(bucket: string, path: string, fileName: string, label: string) {
  const block = await fileBlock(bucket, path, fileName);
  const text = typeof block === "object" && "text" in block ? String(block.text || "") : "";
  if (!text || text.includes("could not read") || text.includes("(empty)")) return `- ${label}: no readable text available`;
  const prompt = `Extract the most important compliance requirements and obligations from the following document text. Return a concise bullet list with no more than 8 bullets. Focus on requirements relevant to an operational compliance document.\n\nDocument: ${label}\n\n${text.slice(0, 18000)}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: SCAN_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      }),
    });
    const json = await res.json();
    if (!res.ok) return `- ${label}: could not summarize automatically`; 
    const textBlock = (json.content || []).find((b: any) => b.type === "text");
    return `- ${label}:\n${String(textBlock?.text || "").trim()}`;
  } catch {
    return `- ${label}: could not summarize automatically`;
  }
}

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
    // The shared Rushroom password is the bootstrap admin; supplier is limited.
    return json({ token: await issueSession({ role, admin: role === "rushroom" }), role, admin: role === "rushroom" });
  }

  // --- login: individual email + password ---------------------------------
  if (action === "loginUser") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!emailOk(email) || !password) return json({ error: "Enter your email and password." }, 400);
    const { data: u } = await db.from("users").select("*").eq("email", email).maybeSingle();
    const bad = json({ error: "Incorrect email or password." }, 401); // generic — no user enumeration
    if (!u || !(await verifyPassword(password, u.password ?? null))) return bad;
    if (!u.email_verified) return json({ error: "Please verify your email first — check your inbox for the link." }, 403);
    if (u.status !== "approved") {
      const msg = (u.status === "rejected" || u.status === "disabled")
        ? "Your account isn't active. Please contact the administrator."
        : "Your account is awaiting administrator approval.";
      return json({ error: msg }, 403);
    }
    const assigned = String(u.role || u.requested_role || "supplier");
    const tier = roleTier(assigned);
    const admin = assigned === "admin";
    const token = await issueSession({ role: tier, admin, uid: u.id, email: u.email, urole: assigned });
    return json({ token, role: tier, admin, urole: assigned, name: u.name });
  }

  // --- public: request a password-reset / set-password link ---------------
  if (action === "requestPasswordReset") {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (emailOk(email)) {
      const { data: u } = await db.from("users").select("id,name,email").eq("email", email).maybeSingle();
      if (u) { const url = await resetLinkFor(u.id); await sendPasswordEmail(u.email, u.name, url); }
    }
    // Generic — never reveal whether the email is registered.
    return json({ ok: true, message: "If that email is registered, a password-reset link has been sent." });
  }

  // --- public: set a new password from a signed link ----------------------
  if (action === "setPassword") {
    const data = await readSigned(String(body.token ?? ""));
    const now = Math.floor(Date.now() / 1000);
    if (!data || data.purpose !== "setpw" || (typeof data.exp === "number" && data.exp < now)) {
      return json({ error: "This link is invalid or has expired. Request a new one." }, 400);
    }
    const password = String(body.password ?? "");
    if (password.length < 8) return json({ error: "Choose a password of at least 8 characters." }, 400);
    const hash = await hashPassword(password);
    // Receiving the emailed link also proves the address, so confirm it.
    const { error } = await db.from("users").update({ password: hash, email_verified: true, updated_at: new Date().toISOString() }).eq("id", data.uid);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // --- public: self-registration (creates a pending user + emails a link) --
  if (action === "registerUser") {
    const name = String(body.name ?? "").trim().slice(0, 120);
    const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
    const phone = String(body.phone ?? "").trim().slice(0, 40);
    const whatsapp = String(body.whatsapp ?? "").trim().slice(0, 40);
    const requested_role = USER_ROLES.includes(String(body.role)) ? String(body.role) : "supplier";
    const password = String(body.password ?? "");
    if (!name || !emailOk(email)) return json({ error: "Please provide your name and a valid email address." }, 400);
    const { data: existing } = await db.from("users").select("id,status").eq("email", email).maybeSingle();
    let uid = existing?.id as string | undefined;
    if (existing) {
      // Refresh contact details only. Never touch the password or status of an
      // existing account from a public request (prevents account takeover).
      await db.from("users").update({ name, phone, whatsapp, requested_role, updated_at: new Date().toISOString() }).eq("id", uid);
    } else {
      if (password.length < 8) return json({ error: "Choose a password of at least 8 characters." }, 400);
      const password_hash = await hashPassword(password);
      const { data: inserted, error } = await db.from("users")
        .insert({ name, email, phone, whatsapp, requested_role, password: password_hash }).select("id").maybeSingle();
      if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The users table isn't set up yet — run the account SQL first." : error.message }, 500);
      uid = inserted?.id;
    }
    if (uid) { const url = await verifyLinkFor(uid); await sendVerificationEmail(email, name, url); }
    // Generic response — never leak whether the email already existed or the link itself.
    return json({ ok: true, message: "Thanks! If your details are valid, a verification link has been sent to your email. An administrator will review your access." });
  }

  // --- public: verify an email from the link ------------------------------
  if (action === "verifyUser") {
    const data = await readSigned(String(body.token ?? ""));
    const now = Math.floor(Date.now() / 1000);
    if (!data || data.purpose !== "verify" || (typeof data.exp === "number" && data.exp < now)) {
      return json({ error: "This verification link is invalid or has expired." }, 400);
    }
    const { data: u } = await db.from("users").select("id,email,name,status").eq("id", data.uid).maybeSingle();
    if (!u) return json({ error: "We couldn't find this registration." }, 404);
    const status = u.status === "pending" ? "verified" : u.status;
    await db.from("users").update({ email_verified: true, status, updated_at: new Date().toISOString() }).eq("id", u.id);
    return json({ ok: true, name: u.name, email: u.email });
  }

  // --- everything else requires a valid token -----------------------------
  const session = await verifySession(body.token);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const role = session.role as string;      // access tier: "rushroom" | "supplier"
  const isAdmin = session.admin === true;    // account-management privilege

  // --- admin account management (requires the admin privilege) ------------
  if (action === "adminListUsers") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const { data, error } = await db.from("users").select("*").order("created_at", { ascending: false });
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The users table isn't set up yet — run the account SQL first." : error.message }, 500);
    // Strip the password hash before returning; surface email-delivery status.
    const users = (data ?? []).map(({ password: _pw, ...u }) => u);
    return json({ users, emailConfigured: !!Deno.env.get("RESEND_API_KEY"), mailFrom: Deno.env.get("MAIL_FROM") || "" });
  }
  if (action === "adminSendTestEmail") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const to = String(body.to ?? session.email ?? "").trim().toLowerCase();
    if (!emailOk(to)) return json({ error: "Enter a valid recipient email address." }, 400);
    if (!Deno.env.get("RESEND_API_KEY")) return json({ error: "Email is not configured yet — set RESEND_API_KEY in the function secrets." }, 400);
    const emailed = await sendEmail(to, "Rushroom Compliance Portal — test email",
      `<p>This is a test email from the Rushroom AB Compliance Portal.</p><p>If you can read this, email delivery is working — verification and password links will now reach users automatically.</p>`);
    if (!emailed) return json({ error: "Resend rejected the send — check the API key and that the MAIL_FROM domain is verified." }, 502);
    return json({ ok: true, emailed: true, to });
  }
  if (action === "adminUpdateUser") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.role !== undefined) { if (!ASSIGNABLE_ROLES.includes(String(body.role))) return json({ error: "Invalid role" }, 400); patch.role = String(body.role); }
    if (body.status !== undefined) { if (!USER_STATUSES.includes(String(body.status))) return json({ error: "Invalid status" }, 400); patch.status = String(body.status); }
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 120);
    if (body.phone !== undefined) patch.phone = String(body.phone).slice(0, 40);
    if (body.whatsapp !== undefined) patch.whatsapp = String(body.whatsapp).slice(0, 40);
    if (body.notes !== undefined) patch.notes = String(body.notes).slice(0, 1000);
    const { error } = await db.from("users").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "adminDeleteUser") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { error } = await db.from("users").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "adminUserVerifyLink") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: u } = await db.from("users").select("id,email,name").eq("id", id).maybeSingle();
    if (!u) return json({ error: "User not found" }, 404);
    const url = await verifyLinkFor(u.id);
    const emailed = await sendVerificationEmail(u.email, u.name, url);
    return json({ ok: true, verifyUrl: url, emailed });
  }
  if (action === "adminUserResetLink") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: u } = await db.from("users").select("id,email,name").eq("id", id).maybeSingle();
    if (!u) return json({ error: "User not found" }, 404);
    const url = await resetLinkFor(u.id);
    const emailed = await sendPasswordEmail(u.email, u.name, url);
    return json({ ok: true, resetUrl: url, emailed });
  }

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
      // Documents are version-managed: attach the version history (newest first)
      // with signed links, and use the latest as the current file.
      let versions: any[] = [];
      const { data: vs } = await db.from("document_versions").select("*").eq("document_id", doc.id).order("created_at", { ascending: false });
      versions = await Promise.all((vs ?? []).map(async (v) => {
        const { data: s } = await db.storage.from(DOC_BUCKET).createSignedUrl(v.storage_path, 60 * 60);
        return { ...v, open_url: s?.signedUrl ?? "" };
      }));
      let open_url = "";
      if (versions.length) open_url = versions[0].open_url;
      else if (doc.storage_path) { const { data: s } = await db.storage.from(DOC_BUCKET).createSignedUrl(doc.storage_path, 60 * 60); open_url = s?.signedUrl ?? ""; }
      else open_url = doc.url || "";
      return { ...doc, open_url, versions };
    }));

    const allStandardVersionIds = docs.flatMap((doc) => (doc.versions || []).flatMap((v: any) => Array.isArray(v.source_standard_version_ids) ? v.source_standard_version_ids : []));
    const allSourceDocumentVersionIds = docs.flatMap((doc) => (doc.versions || []).map((v: any) => v.source_document_version_id).filter(Boolean));
    const standardVersionMap = new Map<string, any>();
    if (allStandardVersionIds.length) {
      const uniq = [...new Set(allStandardVersionIds)];
      const { data: vs } = await db.from("standard_versions").select("*, standard:standard_id(code,title)").in("id", uniq);
      for (const v of vs ?? []) standardVersionMap.set(v.id, v);
    }
    const sourceVersionMap = new Map<string, any>();
    if (allSourceDocumentVersionIds.length) {
      const uniq = [...new Set(allSourceDocumentVersionIds)];
      const { data: sv } = await db.from("document_versions").select("id,document_id,version,file_name,created_at").in("id", uniq);
      for (const v of sv ?? []) sourceVersionMap.set(v.id, v);
    }
    const enrichedDocs = docs.map((doc) => ({
      ...doc,
      versions: (doc.versions || []).map((v: any) => ({
        ...v,
        source_standard_versions: (Array.isArray(v.source_standard_version_ids) ? v.source_standard_version_ids : []).map((id: string) => standardVersionMap.get(id)).filter(Boolean),
        source_document_version: v.source_document_version_id ? sourceVersionMap.get(v.source_document_version_id) : null,
      })),
    }));

    return json({ role, steps: s, documents: enrichedDocs });
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

  // --- action-plan management (Rushroom only) -----------------------------
  if (action === "addStep") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    // NB: the step's action text travels as `actionText` to avoid colliding with
    // the request router field `action`.
    const action_ = String(body.actionText ?? "").trim();
    if (!action_) return json({ error: "action text required" }, 400);
    const { data: maxRow } = await db.from("steps").select("step").order("step", { ascending: false }).limit(1).maybeSingle();
    const step = (maxRow?.step ?? 0) + 1;
    const audience = Array.isArray(body.audience) && body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    const { error } = await db.from("steps").insert({
      step,
      phase: String(body.phase ?? "Unphased").slice(0, 120) || "Unphased",
      action: action_.slice(0, 1000),
      owner: String(body.owner ?? "").slice(0, 200),
      where_how: String(body.where ?? "").slice(0, 300),
      evidence: String(body.evidence ?? "").slice(0, 400),
      folder: String(body.folder ?? "").slice(0, 80),
      priority: String(body.priority ?? "").slice(0, 80),
      status: String(body.status ?? "Open").slice(0, 80) || "Open",
      audience,
      updated_by: "rushroom",
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, step });
  }

  if (action === "updateStep") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const step = Number(body.step);
    if (!step) return json({ error: "step required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: "rushroom" };
    const limits: Record<string, number> = { phase: 120, owner: 200, priority: 80, status: 80, evidence: 400, folder: 80 };
    for (const k of Object.keys(limits)) if (body[k] !== undefined) patch[k] = String(body[k]).slice(0, limits[k]);
    if (body.actionText !== undefined) patch.action = String(body.actionText).slice(0, 1000);
    if (body.where !== undefined) patch.where_how = String(body.where).slice(0, 300);
    if (Array.isArray(body.audience)) patch.audience = body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    const { error } = await db.from("steps").update(patch).eq("step", step);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, step });
  }

  if (action === "deleteStep") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const step = Number(body.step);
    if (!step) return json({ error: "step required" }, 400);
    const { error } = await db.from("steps").delete().eq("step", step);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
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
    const kind = body.kind === "operational" ? "operational" : "template";
    const storagePath = String(body.storagePath ?? "").slice(0, 400);
    const { data: doc, error } = await db.from("documents").insert({
      category: (String(body.category ?? "").trim() || "Uncategorised").slice(0, 80),
      name: name.slice(0, 200),
      url: String(body.url ?? "").slice(0, 1000),
      storage_path: storagePath,
      kind,
      audience,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 500);
    // All documents are version-managed from the first upload onward.
    if (doc?.id) {
      const versionLabel = String(body.version ?? "").slice(0, 80);
      const fileName = String(body.fileName ?? "file").slice(0, 200);
      if (storagePath || versionLabel || fileName) {
        await insertDocumentVersion({
          document_id: doc.id, version: versionLabel,
          file_name: fileName, storage_path: storagePath,
          notes: String(body.notes ?? "").slice(0, 1000), uploaded_by: "rushroom",
        });
      }
    }
    return json({ ok: true, id: doc?.id });
  }

  if (action === "createOperationalDocumentFromTemplate") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const templateDocumentId = String(body.templateDocumentId ?? "");
    if (!templateDocumentId) return json({ error: "templateDocumentId required" }, 400);

    const { data: templateDoc, error: templateErr } = await db.from("documents").select("id,name,category,url,storage_path,audience").eq("id", templateDocumentId).maybeSingle();
    if (templateErr || !templateDoc) return json({ error: "Template not found" }, 404);

    const { data: latestTemplateVersion } = await db.from("document_versions").select("id").eq("document_id", templateDocumentId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const sourceDocumentVersionId = latestTemplateVersion?.id || null;

    const name = String(body.name ?? "").trim() || `${templateDoc.name || "Template"} — As Operated`;
    const audience = Array.isArray(templateDoc.audience) && templateDoc.audience.length ? templateDoc.audience : ["internal"];
    const { data: doc, error } = await db.from("documents").insert({
      category: String(templateDoc.category ?? "Uncategorised").slice(0, 80),
      name: name.slice(0, 200),
      url: String(templateDoc.url ?? "").slice(0, 1000),
      storage_path: String(templateDoc.storage_path ?? "").slice(0, 400),
      kind: "operational",
      audience,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 500);

    const version = String(body.version ?? "v1").trim() || "v1";
    const notes = String(body.notes ?? "").slice(0, 1000);
    if (doc?.id && templateDoc.storage_path) {
      await insertDocumentVersion({
        document_id: doc.id,
        version: version.slice(0, 80),
        file_name: String(templateDoc.name || "template").slice(0, 200),
        storage_path: templateDoc.storage_path,
        notes,
        uploaded_by: "rushroom",
        source_document_version_id: sourceDocumentVersionId,
      });
    }
    return json({ ok: true, id: doc?.id });
  }

  if (action === "suggestDocumentVersion") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const document_id = String(body.documentId ?? "").trim();
    const templateDocumentId = String(body.templateDocumentId ?? "").trim();
    const context = String(body.notes ?? "").trim();
    const preferredVersion = String(body.preferredVersion ?? "").trim();
    const sourceStandardIds = Array.isArray(body.sourceStandardIds) ? body.sourceStandardIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    const sourceStandardVersionIds = Array.isArray(body.sourceStandardVersionIds) ? body.sourceStandardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];

    let doc: any = null;
    let storagePath = "";
    let fileName = "document";
    if (document_id) {
      const { data: foundDoc, error: docErr } = await db.from("documents").select("id,name,kind,storage_path").eq("id", document_id).maybeSingle();
      if (docErr || !foundDoc) return json({ error: "Document not found" }, 404);
      doc = foundDoc;
      const { data: latest } = await db.from("document_versions").select("*").eq("document_id", document_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      // Fall back to the document's own file when no version row exists yet.
      storagePath = latest?.storage_path || foundDoc.storage_path || "";
      fileName = latest?.file_name || doc.name || "document";
    } else if (templateDocumentId) {
      const { data: foundDoc } = await db.from("documents").select("id,name,kind,storage_path").eq("id", templateDocumentId).maybeSingle();
      if (foundDoc) {
        doc = foundDoc;
        const { data: latest } = await db.from("document_versions").select("*").eq("document_id", templateDocumentId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        storagePath = latest?.storage_path || foundDoc.storage_path || "";
        fileName = latest?.file_name || doc.name || "document";
      }
    }

    const content: any[] = [{ type: "text", text: "You are helping Rushroom create or update a compliance-operational document. Draft the next version using the supplied source material and the user's change request. Return strict JSON matching the requested schema." }];
    if (context) content.push({ type: "text", text: `\nChange request / context:\n${context}` });
    if (preferredVersion) content.push({ type: "text", text: `\nPreferred version label:\n${preferredVersion}` });
    if ((document_id || templateDocumentId) && storagePath) {
      content.push({ type: "text", text: "\n=== CURRENT DOCUMENT ===" });
      content.push(await fileBlock(DOC_BUCKET, storagePath, fileName));
    }
    const standardVersionIds = sourceStandardVersionIds.length ? sourceStandardVersionIds : [];
    if (sourceStandardIds.length && !standardVersionIds.length) {
      // backward compatibility: use the latest uploaded version for each standard ID.
      for (const standardId of sourceStandardIds) {
        const { data: latestVersion } = await db.from("standard_versions").select("id").eq("standard_id", standardId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (latestVersion?.id) standardVersionIds.push(latestVersion.id);
      }
    }
    if (standardVersionIds.length) {
      content.push({ type: "text", text: "\n=== REFERENCE STANDARDS & REGULATIONS ===" });
      const summaries: string[] = [];
      for (const standardVersionId of standardVersionIds) {
        const { data: version } = await db.from("standard_versions").select("*, standard:standard_id(code,title,category)").eq("id", standardVersionId).maybeSingle();
        if (!version) continue;
        const label = `${version.standard?.code || version.standard?.title || "standard"}${version.version ? ` ${version.version}` : ""}`;
        if (version.storage_path) {
          const summary = await summarizeRequirementSource(STD_BUCKET, version.storage_path, version.file_name || label, `${label}`);
          summaries.push(summary);
        } else {
          summaries.push(`- ${label}: no uploaded file yet`);
        }
      }
      content.push({ type: "text", text: summaries.join("\n") });
    }
    if (!document_id && !templateDocumentId && !standardVersionIds.length) return json({ error: "Provide either a current document, a template, or at least one source standard/regulation." }, 400);

    const system = `You are an expert compliance-document editor for Rushroom AB. Review the supplied source material and produce a practical next version draft. Keep it concise, professional, and suitable for compliance use. If the document contains outdated wording, add clear improvement suggestions. When reference standards/regulations are supplied, reflect their relevant requirements and terminology. Return a JSON object with:
- summary: a short explanation of the proposed update
- proposed_changes: an array of objects with title, description, rationale
- draft_text: a full draft of the updated document in plain markdown
- version_hint: a suggested version label such as Rev C or 2026-08
- file_name_hint: a file name suggestion such as as-operated-v3.md`;

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: { type: "json_schema", schema: DOCUMENT_DRAFT_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to draft the document update." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed. Try again." }, 502); }

    const proposedChanges = Array.isArray(parsed.proposed_changes) ? parsed.proposed_changes : [];
    return json({
      ok: true,
      summary: String(parsed.summary || "Draft prepared."),
      proposedChanges,
      draftText: String(parsed.draft_text || ""),
      versionHint: String(parsed.version_hint || "AI draft"),
      fileNameHint: String(parsed.file_name_hint || "draft.md"),
      usage: usageOf(apiJson),
    });
  }

  if (action === "publishDocumentDraft") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const document_id = String(body.documentId ?? "").trim();
    const path = String(body.path ?? "");
    const draftText = String(body.draftText ?? "");
    const fileName = String(body.fileName ?? "draft.md");
    if (!path || !draftText.trim()) return json({ error: "path and draftText required" }, 400);

    const approvedChanges = Array.isArray(body.approvedChanges) ? body.approvedChanges : [];
    const noteText = [String(body.notes ?? "").slice(0, 1000), approvedChanges.length ? `Approved changes: ${approvedChanges.join(", ")}` : ""].filter(Boolean).join("\n");
    const sourceStandardVersionIds = Array.isArray(body.sourceStandardVersionIds) ? body.sourceStandardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    let sourceDocumentVersionId = String(body.sourceDocumentVersionId ?? "").trim() || "";

    let targetDocumentId = document_id;
    if (!targetDocumentId) {
      const name = String(body.newDocumentName ?? "").trim() || "New As Operated";
      const templateDocumentId = String(body.templateDocumentId ?? "").trim();
      const category = String(body.category ?? "").trim() || (templateDocumentId ? "Uncategorised" : "Uncategorised");
      const audience = Array.isArray(body.audience) && body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
      let templateDoc: any = null;
      if (templateDocumentId) {
        const { data: found } = await db.from("documents").select("id,category,audience,storage_path").eq("id", templateDocumentId).maybeSingle();
        templateDoc = found;
      }
      const { data: doc, error: insertErr } = await db.from("documents").insert({
        category: String(templateDoc?.category ?? category).slice(0, 80),
        name: name.slice(0, 200),
        url: "",
        storage_path: path,
        kind: "operational",
        audience: Array.isArray(templateDoc?.audience) && templateDoc.audience.length ? templateDoc.audience : audience,
      }).select("id").maybeSingle();
      if (insertErr) return json({ error: insertErr.message }, 500);
      targetDocumentId = doc?.id || "";
      if (!sourceDocumentVersionId && templateDocumentId) {
        const { data: latestTemplateVersion } = await db.from("document_versions").select("id").eq("document_id", templateDocumentId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        sourceDocumentVersionId = latestTemplateVersion?.id || "";
      }
    }
    if (!targetDocumentId) return json({ error: "documentId or newDocumentName required" }, 400);
    if (!sourceDocumentVersionId && document_id) {
      const { data: latestSourceVersion } = await db.from("document_versions").select("id").eq("document_id", document_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      sourceDocumentVersionId = latestSourceVersion?.id || "";
    }

    const { error: insertErr } = await insertDocumentVersion({
      document_id: targetDocumentId,
      version: String(body.version ?? "AI draft").slice(0, 80),
      file_name: fileName.slice(0, 200),
      storage_path: path,
      notes: noteText.slice(0, 1000),
      uploaded_by: "rushroom",
      source_document_version_id: sourceDocumentVersionId || null,
      source_standard_version_ids: sourceStandardVersionIds.length ? sourceStandardVersionIds : [],
    });
    if (insertErr) return json({ error: insertErr.message }, 500);
    await db.from("documents").update({ storage_path: path }).eq("id", targetDocumentId);
    return json({ ok: true, id: targetDocumentId });
  }

  if (action === "addDocumentVersion") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const document_id = String(body.documentId ?? "");
    const path = String(body.path ?? "");
    const fileName = String(body.fileName ?? "");
    const sourceStandardVersionIds = Array.isArray(body.sourceStandardVersionIds) ? body.sourceStandardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    const sourceDocumentVersionId = String(body.sourceDocumentVersionId ?? "").trim() || null;
    if (!document_id || !path || !fileName) return json({ error: "documentId, path, fileName required" }, 400);
    const { error } = await insertDocumentVersion({
      document_id, version: String(body.version ?? "").slice(0, 80),
      file_name: fileName.slice(0, 200), storage_path: path,
      notes: String(body.notes ?? "").slice(0, 1000), uploaded_by: "rushroom",
      source_document_version_id: sourceDocumentVersionId,
      source_standard_version_ids: sourceStandardVersionIds.length ? sourceStandardVersionIds : [],
    });
    if (error) return json({ error: error.message }, 500);
    await db.from("documents").update({ storage_path: path }).eq("id", document_id); // keep current pointer in sync
    return json({ ok: true });
  }

  if (action === "updateDocument") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = {};
    if (body.kind !== undefined) patch.kind = body.kind === "operational" ? "operational" : "template";
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 200);
    if (body.category !== undefined) patch.category = String(body.category).slice(0, 80);
    if (Array.isArray(body.audience)) patch.audience = body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
    const { error } = await db.from("documents").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    // Moving a single-file template into the versioned operational track: seed v1.
    if (patch.kind === "operational") {
      const { data: doc } = await db.from("documents").select("storage_path").eq("id", id).maybeSingle();
      const { count } = await db.from("document_versions").select("id", { count: "exact", head: true }).eq("document_id", id);
      if (doc?.storage_path && !count) {
        await db.from("document_versions").insert({
          document_id: id, version: "v1", file_name: (doc.storage_path.split("/").pop() || "file"),
          storage_path: doc.storage_path, uploaded_by: "rushroom",
        });
      }
    }
    return json({ ok: true });
  }

  if (action === "deleteDocument") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    return json({ error: "Documents are version-controlled and cannot be deleted. Create a new version instead." }, 400);
  }

  // --- Standards & Regulations register -----------------------------------
  if (action === "standards") {
    const { data: stds } = await db.from("standards").select("*").order("code");
    const list = role === "supplier" ? (stds ?? []).filter((s) => isSupplierStep(s.audience)) : (stds ?? []);
    const ids = list.map((s) => s.id);
    let versions: any[] = [];
    if (ids.length) {
      const { data: vs } = await db.from("standard_versions").select("*").in("standard_id", ids).order("created_at", { ascending: false });
      versions = vs ?? [];
    }
    const withUrls = await Promise.all(versions.map(async (v) => {
      const { data: signed } = await db.storage.from(STD_BUCKET).createSignedUrl(v.storage_path, 60 * 60);
      return { ...v, open_url: signed?.signedUrl ?? "" };
    }));
    const byStd: Record<string, any[]> = {};
    for (const v of withUrls) (byStd[v.standard_id] ||= []).push(v);
    const result = list.map((s) => ({ ...s, versions: byStd[s.id] ?? [] }));
    return json({ role, standards: result });
  }

  if (action === "addStandard") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const code = String(body.code ?? "").trim();
    const title = String(body.title ?? "").trim();
    if (!code && !title) return json({ error: "code or title required" }, 400);
    const audience = Array.isArray(body.audience) && body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    const row: Record<string, unknown> = {
      code: code.slice(0, 120), title: title.slice(0, 300), category: String(body.category ?? "").slice(0, 80), audience,
      reg_type: String(body.regType ?? "").slice(0, 60),
      jurisdiction: String(body.jurisdiction ?? "").slice(0, 60),
    };
    let res = await db.from("standards").insert(row).select("id").maybeSingle();
    // Self-heal if the optional reg_type / jurisdiction columns aren't added yet.
    if (res.error && /reg_type|jurisdiction/.test(res.error.message || "")) {
      const { reg_type: _r, jurisdiction: _j, ...base } = row;
      res = await db.from("standards").insert(base).select("id").maybeSingle();
    }
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true, id: res.data?.id });
  }

  if (action === "deleteStandard") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: vs } = await db.from("standard_versions").select("storage_path").eq("standard_id", id);
    const paths = (vs ?? []).map((v) => v.storage_path).filter(Boolean);
    if (paths.length) await db.storage.from(STD_BUCKET).remove(paths);
    const { error } = await db.from("standards").delete().eq("id", id); // cascade removes version rows
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "stdUploadUrl") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const path = `${Date.now()}-${safeName(String(body.fileName ?? "file"))}`;
    const { data, error } = await db.storage.from(STD_BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ signedUrl: data.signedUrl, token: data.token, path });
  }

  if (action === "addStandardVersion") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const standard_id = String(body.standardId ?? "");
    const path = String(body.path ?? "");
    const fileName = String(body.fileName ?? "");
    if (!standard_id || !path || !fileName) return json({ error: "standardId, path, fileName required" }, 400);
    let versionLabel = String(body.version ?? "").slice(0, 80);
    if (!versionLabel.trim()) {
      const { count } = await db.from("standard_versions").select("id", { count: "exact", head: true }).eq("standard_id", standard_id);
      versionLabel = `v${(count ?? 0) + 1}`;
    }
    const { error } = await db.from("standard_versions").insert({
      standard_id,
      version: versionLabel,
      effective_date: String(body.effectiveDate ?? "").slice(0, 40),
      notes: String(body.notes ?? "").slice(0, 1000),
      storage_path: path, file_name: fileName.slice(0, 200), uploaded_by: "rushroom",
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "suggestStandardMetadata") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);
    const path = String(body.path ?? "").trim();
    const fileName = String(body.fileName ?? "file").trim();
    if (!path) return json({ error: "path required" }, 400);

    const system = `You are a compliance librarian reading a single standard or regulation document. Extract its catalogue metadata precisely from the document itself — do not invent values. Return a JSON object:
- code: the official designation exactly as published (e.g. "EN 60598-1", "2014/35/EU", "(EU) 2019/2020", "EN IEC 63000"). If none is visible, "".
- title: the official document title.
- category: a short classifying DOMAIN tag for a compliance register — one of LVD, EMC, RoHS, REACH, Ecodesign, Energy labelling, Packaging/PPWR, WEEE, Batteries, Radio/RED, CPR, Machinery, or another concise domain tag if none fit.
- reg_type: the regulatory TYPE/level — exactly one of "EU Directive", "EU Regulation", "Harmonised Standard (EN)", "National Standard", "International (IEC/ISO)", or "Other". Infer from the designation: "2014/35/EU" → EU Directive; "(EU) 2019/2020" → EU Regulation; a code starting "EN " → Harmonised Standard (EN); "IEC …"/"ISO …" → International (IEC/ISO); a national code (e.g. "DIN …", "BS …", "NF …", "SS …", "UNE …") → National Standard. If unclear, "".
- jurisdiction: where it applies — "EU" for EU directives/regulations and harmonised EN standards; "International" for IEC/ISO; or the specific country for a national standard (e.g. "Germany", "France", "Sweden"). If unclear, "".
- version: the edition / amendment / year that identifies this revision (e.g. "2015+A1:2022", "Rev 3", "2014"). If none is visible, "".
- effective_date: the date the document applies from if explicitly stated (ISO or as printed), else "".
- summary: one sentence on what the document covers.`;

    const content: any[] = [
      { type: "text", text: "Extract the metadata for this standard/regulation document." },
      await fileBlock(STD_BUCKET, path, fileName),
    ];

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 2000,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: STANDARD_META_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to read this document." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed. Try again or fill the fields manually." }, 502); }
    return json({
      ok: true,
      code: String(parsed.code || ""),
      title: String(parsed.title || ""),
      category: String(parsed.category || ""),
      regType: String(parsed.reg_type || ""),
      jurisdiction: String(parsed.jurisdiction || ""),
      version: String(parsed.version || ""),
      effectiveDate: String(parsed.effective_date || ""),
      summary: String(parsed.summary || ""),
      usage: usageOf(apiJson),
    });
  }

  if (action === "suggestFileMetadata") {
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);
    const bucketKey = String(body.bucket ?? "documents");
    const bucket = bucketKey === "standards" ? STD_BUCKET : bucketKey === "uploads" ? BUCKET : DOC_BUCKET;
    // The document library and standards register are Rushroom-managed; supplier
    // uploads may be auto-described by whoever uploaded them.
    if ((bucketKey === "documents" || bucketKey === "standards") && role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const path = String(body.path ?? "").trim();
    const fileName = String(body.fileName ?? "file").trim();
    if (!path) return json({ error: "path required" }, 400);

    const system = `You are a compliance librarian cataloguing an uploaded file. Read the document and extract its metadata precisely — do not invent values. Return a JSON object:
- name: a clear, concise title for the document (e.g. "EU Declaration of Conformity", "LVD Safety Test Report — Model X", "Supplier Declaration of Compliance"). If the file has an obvious title, use it.
- category: a short classifying tag for a compliance file library — e.g. Declarations & CE, Technical file, Test reports, Suppliers, Materials & packaging, Records & monitoring, or another concise domain tag if none fit.
- version: an edition / revision / date-based version label if the document states one (e.g. "Rev B", "2026-06", "2015+A1:2022"), else "".
- effective_date: a date the document is dated or effective from if stated, else "".
- kind: "template" if this is a blank or fillable template, form, or reference-requirement document; "operational" if it is completed operational evidence or a filled-in record; else "".
- summary: one sentence describing what the document is.`;

    const content: any[] = [
      { type: "text", text: "Extract catalogue metadata for this uploaded compliance file." },
      await fileBlock(bucket, path, fileName),
    ];

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 2000,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: FILE_META_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to read this document." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed. Try again or fill the fields manually." }, 502); }
    return json({
      ok: true,
      name: String(parsed.name || ""),
      category: String(parsed.category || ""),
      version: String(parsed.version || ""),
      effectiveDate: String(parsed.effective_date || ""),
      kind: String(parsed.kind || ""),
      summary: String(parsed.summary || ""),
      usage: usageOf(apiJson),
    });
  }

  if (action === "deleteStandardVersion") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: v } = await db.from("standard_versions").select("storage_path").eq("id", id).maybeSingle();
    if (v?.storage_path) await db.storage.from(STD_BUCKET).remove([v.storage_path]);
    const { error } = await db.from("standard_versions").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // --- AI deviation monitoring (Rushroom only) ----------------------------
  if (action === "deviations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    // Fetch the latest scan and the one before it, so we can flag findings that
    // are new since the previous scan (yellow-marked in the UI).
    const { data: scans } = await db.from("deviation_scans").select("*").order("created_at", { ascending: false }).limit(2);
    const scan = scans?.[0];
    const prevScan = scans?.[1];
    if (!scan) return json({ scan: null, findings: [] });
    const sigOf = (f: any) => `${f.severity}|${String(f.title || "").trim().toLowerCase()}|${String(f.document || "").trim().toLowerCase()}|${String(f.standard || "").trim().toLowerCase()}`;
    let prevSet: Set<string> | null = null;
    if (prevScan) {
      const { data: prevFindings } = await db.from("deviation_findings").select("severity,title,document,standard").eq("scan_id", prevScan.id);
      prevSet = new Set((prevFindings ?? []).map(sigOf));
    }
    const { data: findings } = await db.from("deviation_findings").select("*").eq("scan_id", scan.id);
    const withNew = (findings ?? []).map((f) => ({ ...f, is_new: prevSet ? !prevSet.has(sigOf(f)) : false }));
    return json({ scan, findings: withNew, hasPrevious: !!prevScan });
  }

  if (action === "runDeviationScan") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);

    // Operational ("Company as Operated") documents are the evidence being audited.
    const { data: docs } = await db.from("documents").select("id,name,storage_path").eq("kind", "operational").neq("storage_path", "");
    const storedDocs = (docs ?? []).filter((d) => d.storage_path);

    // ---- Phase A: structured findings from clause-level interpretations ----
    // Instant, no LLM. A document with any interpretations is "covered" and is
    // NOT sent to the AI — its deviations/pending items come from here instead.
    const { data: interps } = await db.from("as_operates_interpretations").select(
      "compliance_status, interpretation_text, rationale, deviation_description, deviation_accepted_by, document_version_id, clause:clause_id(clause_ref, clause_title, standard:standard_version_id(standard:standard_id(code,title)))",
    );
    const interpList = interps ?? [];
    const docNameByVersion: Record<string, string> = {};
    const coveredDocIds = new Set<string>();
    const interpVersionIds = [...new Set(interpList.map((i) => i.document_version_id))];
    if (interpVersionIds.length) {
      const { data: vers } = await db.from("document_versions").select("id, file_name, document_id, document:document_id(name, kind)").in("id", interpVersionIds);
      for (const v of vers ?? []) {
        docNameByVersion[v.id] = (v as any).document?.name || v.file_name || "document";
        if (((v as any).document?.kind || "template") === "operational") coveredDocIds.add(v.document_id);
      }
    }
    const sevForInterp = (i: any): string | null => {
      if (i.compliance_status === "deviation") return i.deviation_accepted_by ? "Info" : "High";
      if (i.compliance_status === "pending") return "Medium";
      return null; // compliant / not_applicable → no finding
    };
    const structuredFindings = interpList.map((i: any) => {
      const sev = sevForInterp(i);
      if (!sev) return null;
      const c = i.clause || {};
      const stdCode = c.standard?.standard?.code || "";
      const isDev = i.compliance_status === "deviation";
      return {
        severity: sev,
        title: (isDev ? `Deviation on clause ${c.clause_ref || "?"}${i.deviation_accepted_by ? " (accepted)" : ""}` : `Interpretation pending review — clause ${c.clause_ref || "?"}`).slice(0, 300),
        description: String(i.deviation_description || i.interpretation_text || i.rationale || "").slice(0, 4000),
        document: String(docNameByVersion[i.document_version_id] || "document").slice(0, 300),
        standard: `${stdCode}${c.clause_ref ? " " + c.clause_ref : ""}`.trim().slice(0, 300),
        recommendation: (isDev ? (i.deviation_accepted_by ? `Accepted by ${i.deviation_accepted_by} — keep documented.` : "Close this deviation, or document an accepted-deviation rationale and approver.") : "Review this clause and set a compliance status.").slice(0, 2000),
        source: "structured",
      };
    }).filter(Boolean) as any[];

    // ---- Phase B: AI fallback for operational docs WITHOUT interpretations ----
    const uncoveredDocs = storedDocs.filter((d) => !coveredDocIds.has(d.id));
    // Latest uploaded version of each standard (needed for the AI comparison).
    const { data: stds } = await db.from("standards").select("id,code,title,category").order("code");
    const standards: any[] = [];
    for (const s of stds ?? []) {
      const { data: v } = await db.from("standard_versions").select("*").eq("standard_id", s.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (v?.storage_path) standards.push({ ...s, version: v.version, storage_path: v.storage_path, file_name: v.file_name });
    }
    const willRunAI = uncoveredDocs.length > 0 && standards.length > 0;

    // Guardrails: only bail when there is genuinely nothing to do.
    if (!storedDocs.length && !interpList.length) return json({ error: "No operational documents to check — mark documents as “Company as Operated” in the Document library first." }, 400);
    if (!structuredFindings.length && coveredDocIds.size === 0 && !willRunAI) {
      if (!standards.length) return json({ error: "No standards with an uploaded version yet — add standards and upload files first." }, 400);
      return json({ error: "Nothing to scan — add clause interpretations or operational documents first." }, 400);
    }
    if (willRunAI && !ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets (or add interpretations so the scan can run structured-only)." }, 400);

    let aiFindings: any[] = [];
    let aiModel = ""; let aiSummary = ""; let aiNote = "";
    let aiUsage: any = { model: "", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    if (willRunAI) {
      const content: any[] = [{ type: "text", text: "=== STANDARDS & REGULATIONS (the requirements) ===" }];
      for (const s of standards) {
        content.push({ type: "text", text: `\n--- STANDARD: ${s.code}${s.title ? ` — ${s.title}` : ""}${s.category ? ` [${s.category}]` : ""} (version ${s.version || "?"}) ---` });
        content.push(await fileBlock(STD_BUCKET, s.storage_path, s.file_name));
      }
      content.push({ type: "text", text: "\n\n=== COMPLIANCE DOCUMENTS (what Rushroom has produced) ===" });
      for (const d of uncoveredDocs) {
        content.push({ type: "text", text: `\n--- DOCUMENT: ${d.name} ---` });
        content.push(await fileBlock(DOC_BUCKET, d.storage_path, d.storage_path));
      }
      content.push({ type: "text", text: "\nAnalyse the compliance DOCUMENTS against the STANDARDS & REGULATIONS above. Report deviations, gaps, missing evidence, outdated references, and unmet requirements. Only report genuine issues grounded in the supplied material; do not invent requirements that were not provided." });

      const system = `You are a meticulous EU product-compliance auditor for Rushroom AB (LED system-furniture). Compare the company's compliance DOCUMENTS against the provided STANDARDS & REGULATIONS and surface where the documents deviate from, or fall short of, the standards.

Assign each finding a severity:
- Critical: a legal blocker to selling or CE-marking (missing Declaration of Conformity, an unmet mandatory requirement, a safety/EMC/energy non-conformity).
- High: a significant gap that must be closed before launch.
- Medium: an incomplete or outdated item that needs attention.
- Low: a minor inconsistency or improvement.
- Info: an observation, not a deviation.

Be specific: name the exact document and the exact standard (and clause where possible) each finding relates to, and give a concrete recommendation. If everything aligns, return an empty findings array and say so in the summary.`;

      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: SCAN_MODEL, max_tokens: 16000, thinking: { type: "adaptive" },
            output_config: { effort: "medium", format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
            system, messages: [{ role: "user", content }],
          }),
        });
        const apiJson = await res.json();
        if (!res.ok) throw new Error(`Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}`);
        if (apiJson.stop_reason === "refusal") throw new Error("the AI declined to complete the analysis (refusal)");
        const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
        const parsed = JSON.parse(textBlock?.text || "{}");
        aiFindings = (Array.isArray(parsed.findings) ? parsed.findings : []).map((f: any) => ({
          severity: SEVERITIES.includes(f.severity) ? f.severity : "Info",
          title: String(f.title || "").slice(0, 300),
          description: String(f.description || "").slice(0, 4000),
          document: String(f.document || "").slice(0, 300),
          standard: String(f.standard || "").slice(0, 300),
          recommendation: String(f.recommendation || "").slice(0, 2000),
          source: "ai_inference",
        }));
        aiModel = apiJson.model || SCAN_MODEL;
        aiSummary = String(parsed.summary || "");
        aiUsage = usageOf(apiJson);
      } catch (e) {
        // AI failure is non-fatal when we still have structured findings.
        if (!structuredFindings.length && !coveredDocIds.size) return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
        aiNote = ` (AI analysis of ${uncoveredDocs.length} uncovered document(s) failed: ${(e as Error).message})`;
      }
    }

    // ---- Combine, count, persist ----
    const allFindings = [...structuredFindings, ...aiFindings];
    const counts: Record<string, number> = {};
    for (const f of allFindings) counts[f.severity] = (counts[f.severity] || 0) + 1;

    const summaryParts: string[] = [];
    if (coveredDocIds.size) summaryParts.push(`${coveredDocIds.size} document(s) checked via structured interpretations — ${structuredFindings.length} finding(s), no AI needed.`);
    if (willRunAI && !aiNote) summaryParts.push(aiSummary || `${uncoveredDocs.length} document(s) analysed with AI.`);
    if (aiNote) summaryParts.push(aiNote.trim());
    if (!summaryParts.length) summaryParts.push(allFindings.length ? `${allFindings.length} finding(s).` : "No issues found.");

    const scanRow: Record<string, unknown> = {
      model: aiModel || "structured", status: "ok", summary: summaryParts.join(" ").slice(0, 4000),
      counts, docs_scanned: coveredDocIds.size + (willRunAI && !aiNote ? uncoveredDocs.length : 0), standards_scanned: standards.length,
      usage: aiUsage,
    };
    let scanResp = await db.from("deviation_scans").insert(scanRow).select("*").maybeSingle();
    // Self-heal if the optional `usage` column hasn't been added yet.
    if (scanResp.error && /usage/.test(scanResp.error.message || "")) {
      const { usage: _u, ...noUsage } = scanRow;
      scanResp = await db.from("deviation_scans").insert(noUsage).select("*").maybeSingle();
    }
    const scan = scanResp.data;
    if (scanResp.error || !scan) return json({ error: `Could not save scan: ${scanResp.error?.message}` }, 500);

    if (allFindings.length) {
      const rows = allFindings.slice(0, 300).map((f: any) => ({ scan_id: scan.id, ...f }));
      const { error: fErr } = await db.from("deviation_findings").insert(rows);
      if (fErr) return json({ error: `Could not save findings: ${fErr.message}` }, 500);
    }
    return json({ ok: true, scan: { ...scan, usage: scan.usage ?? aiUsage }, findings: allFindings, structuredCount: structuredFindings.length, aiCount: aiFindings.length, usage: aiUsage });
  }

  if (action === "deleteUpload") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: u } = await db.from("uploads").select("file_path").eq("id", id).maybeSingle();
    if (u?.file_path) await db.storage.from(BUCKET).remove([u.file_path]);
    const { error } = await db.from("uploads").delete().eq("id", id);
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

  // ---- LEVEL 2: Structured Clause-Level Interpretations ----

  if (action === "extractStandardClauses") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured" }, 400);
    const standardVersionId = String(body.standardVersionId ?? "").trim();
    if (!standardVersionId) return json({ error: "standardVersionId required" }, 400);
    const maxClauses = Number(body.maxClauses ?? 200) || 200;

    const { data: version } = await db.from("standard_versions")
      .select("*, standard:standard_id(code,title)").eq("id", standardVersionId).maybeSingle();
    if (!version) return json({ error: "Standard version not found" }, 404);
    if (!version.storage_path) return json({ error: "Standard version has no uploaded file" }, 400);

    const fileBlock_ = await fileBlock(STD_BUCKET, version.storage_path, version.file_name || "standard");
    const content = [{
      type: "text",
      text: `Extract all compliance clauses from this standard document. Return a JSON array of clause objects with this structure:\n[\n  { "clause_ref": "4.1", "clause_title": "Title", "clause_text": "requirement text", "requirement_type": "mandatory|conditional|informative", "parent_clause_ref": "4" or null },\n  ...\n]\n\nFocus on requirements, not explanatory text. Return up to ${maxClauses} clauses.`,
    }, fileBlock_];

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL, max_tokens: 12000,
          system: "You are an expert regulatory compliance document analyst. Extract all clauses from the provided standard. Be precise and concise.",
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      if (!res.ok) return json({ error: `Claude API error: ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }

    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any[] = [];
    try {
      const jsonStr = (textBlock?.text || "").match(/\[[\s\S]*\]/)?.[0] || "[]";
      parsed = JSON.parse(jsonStr);
    } catch { return json({ error: "Could not parse AI clause response" }, 502); }

    if (!Array.isArray(parsed) || !parsed.length) return json({ error: "No clauses extracted" }, 400);

    // Build a parent-ref → id map for linking
    const clausesByRef: Record<string, any> = {};
    const toInsert: any[] = [];
    let insertedCount = 0;

    for (const clause of parsed.slice(0, maxClauses)) {
      const ref = String(clause.clause_ref ?? "").trim().slice(0, 120);
      if (!ref) continue;
      const key = `${standardVersionId}:${ref}`;
      if (clausesByRef[key]) continue; // skip if already queued
      clausesByRef[key] = clause;
      toInsert.push({
        standard_version_id: standardVersionId,
        clause_ref: ref,
        clause_title: String(clause.clause_title ?? "").slice(0, 300),
        clause_text: String(clause.clause_text ?? "").slice(0, 4000),
        requirement_type: ["mandatory", "conditional", "informative"].includes(String(clause.requirement_type))
          ? clause.requirement_type : "mandatory",
        ai_generated: true,
      });
    }

    if (!toInsert.length) return json({ error: "No valid clauses to insert" }, 400);

    const { data: inserted, error: insertErr } = await db.from("standard_clauses").insert(toInsert).select("id,clause_ref");
    if (insertErr) {
      if (insertErr.code === "23505") {
        // Duplicate key: clauses already exist for this standard version
        return json({ error: "Clauses already exist for this standard version. Clear them first if you want to re-extract." });
      }
      return json({ error: `Insert error: ${insertErr.message}` }, 500);
    }

    insertedCount = (inserted ?? []).length;

    // Now link parents: for each clause, find its parent_ref and update parent_clause_id
    for (const clause of (inserted ?? [])) {
      const orig = toInsert.find((t) => t.clause_ref === clause.clause_ref);
      if (!orig) continue;
      const parentRef = String(orig.clause_ref).replace(/\.[^.]+$/, "");
      if (parentRef === orig.clause_ref) continue; // no parent
      const parent = (inserted ?? []).find((p) => p.clause_ref === parentRef);
      if (parent?.id) {
        await db.from("standard_clauses").update({ parent_clause_id: parent.id }).eq("id", clause.id);
      }
    }

    return json({ ok: true, inserted: insertedCount, standard: version.standard?.code, version: version.version, usage: usageOf(apiJson) });
  }

  if (action === "generateInterpretations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured" }, 400);
    const documentVersionId = String(body.documentVersionId ?? "").trim();
    const clauseIds = (Array.isArray(body.clauseIds) ? body.clauseIds.filter((v: unknown) => String(v ?? "").trim()) : []).slice(0, 60);
    if (!documentVersionId || !clauseIds.length) return json({ error: "documentVersionId and clauseIds required" }, 400);

    // Fetch the document version
    const { data: docVer } = await db.from("document_versions").select("*, document:document_id(name)").eq("id", documentVersionId).maybeSingle();
    if (!docVer) return json({ error: "Document version not found" }, 404);
    if (!docVer.storage_path) return json({ error: "Document version has no uploaded file" }, 400);

    // Fetch all clauses
    const { data: clauses } = await db.from("standard_clauses").select("*").in("id", clauseIds);
    if (!clauses || !clauses.length) return json({ error: "No clauses found" }, 404);

    // Send the actual document FILE to Claude (so PDFs work — not just text),
    // and interpret clauses in BATCHES (one call per ~10 clauses, not per clause).
    const docBlock = await fileBlock(DOC_BUCKET, docVer.storage_path, docVer.file_name || docVer.document?.name || "document");
    const INTERP_SCHEMA = {
      type: "object", additionalProperties: false,
      required: ["interpretations"],
      properties: {
        interpretations: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["index", "interpretation_text", "compliance_status", "rationale"],
            properties: {
              index: { type: "integer" },
              interpretation_text: { type: "string" },
              compliance_status: { type: "string", enum: ["compliant", "deviation", "not_applicable", "pending"] },
              rationale: { type: "string" },
            },
          },
        },
      },
    };
    const interpSystem = "You are a meticulous EU product-compliance auditor. For each requirement clause, read the attached company operational document and state how the document implements that clause. Base every interpretation strictly on the document — never invent implementation details. If the document does not address a clause, mark it 'pending' (unclear) or 'not_applicable', and say so in the rationale. Echo each clause's [index] exactly.";

    const results: any[] = [];
    let usageTotal: any = { model: SCAN_MODEL, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const batchSize = 10;
    for (let i = 0; i < clauses.length; i += batchSize) {
      const batch = clauses.slice(i, i + batchSize);
      const list = batch.map((c, j) => `[${j + 1}] Clause ${c.clause_ref}${c.clause_title ? ` — ${c.clause_title}` : ""}\nRequirement: ${String(c.clause_text || "").slice(0, 1500)}`).join("\n\n");
      const content: any[] = [
        { type: "text", text: `Interpret how the ATTACHED company operational document implements each of the following ${batch.length} requirement clause(s). Return exactly one interpretation per clause, echoing its [index].\n\n${list}` },
        docBlock,
      ];
      const markPending = () => batch.forEach((c) => results.push({ clause_id: c.id, interpretation_text: "", compliance_status: "pending", rationale: "", ai_generated: false }));
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: SCAN_MODEL, max_tokens: 12000,
            thinking: { type: "adaptive" },
            output_config: { effort: "low", format: { type: "json_schema", schema: INTERP_SCHEMA } },
            system: interpSystem,
            messages: [{ role: "user", content }],
          }),
        });
        const apiJson = await res.json();
        usageTotal = addUsage(usageTotal, usageOf(apiJson));
        if (!res.ok || apiJson.stop_reason === "refusal") { markPending(); continue; }
        const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
        const parsed = JSON.parse(textBlock?.text || "{}");
        const arr: any[] = Array.isArray(parsed.interpretations) ? parsed.interpretations : [];
        const byIdx = new Map(arr.map((o) => [Number(o.index), o]));
        batch.forEach((c, j) => {
          const o = byIdx.get(j + 1) || {};
          const text = String(o.interpretation_text ?? "").slice(0, 4000);
          results.push({
            clause_id: c.id,
            interpretation_text: text,
            compliance_status: ["compliant", "deviation", "not_applicable", "pending"].includes(String(o.compliance_status)) ? o.compliance_status : "pending",
            rationale: String(o.rationale ?? "").slice(0, 2000),
            ai_generated: !!text,
          });
        });
      } catch { markPending(); }
    }

    // Insert interpretations (skip duplicates)
    const toInsert = results.map((r) => ({
      clause_id: r.clause_id,
      document_version_id: documentVersionId,
      interpretation_text: r.interpretation_text,
      compliance_status: r.compliance_status,
      rationale: r.rationale,
      ai_generated: r.ai_generated,
    }));

    // Insert new interpretations, ignoring any that already exist for the same
    // (clause, document version) pair — the table has a unique constraint on it.
    const { data: inserted, error: insertErr } = await db.from("as_operates_interpretations")
      .upsert(toInsert, { onConflict: "clause_id,document_version_id", ignoreDuplicates: true }).select("id");
    if (insertErr && insertErr.code !== "23505") {
      return json({ error: `Insert error: ${insertErr.message}` }, 500);
    }

    return json({ ok: true, generated: (inserted ?? []).length, total: clauseIds.length, usage: usageTotal });
  }

  if (action === "saveInterpretation") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.interpretationText !== undefined) patch.interpretation_text = String(body.interpretationText).slice(0, 4000);
    if (body.complianceStatus !== undefined) {
      if (!["compliant", "deviation", "not_applicable", "pending"].includes(String(body.complianceStatus))) {
        return json({ error: "Invalid complianceStatus" }, 400);
      }
      patch.compliance_status = String(body.complianceStatus);
    }
    if (body.rationale !== undefined) patch.rationale = String(body.rationale).slice(0, 2000);
    if (body.deviationDescription !== undefined) patch.deviation_description = String(body.deviationDescription).slice(0, 2000);
    if (body.deviationAcceptedBy !== undefined && String(body.deviationAcceptedBy).trim()) {
      patch.deviation_accepted_by = String(body.deviationAcceptedBy).slice(0, 120);
      patch.deviation_accepted_at = new Date().toISOString();
    }
    if (body.reviewedBy !== undefined && String(body.reviewedBy).trim()) {
      patch.reviewed_by = String(body.reviewedBy).slice(0, 120);
      patch.reviewed_at = new Date().toISOString();
    }

    if (!id || !Object.keys(patch).length) return json({ error: "id and at least one field required" }, 400);

    // When the interpretation text changes, snapshot the prior text so the UI can
    // show a version-to-version diff. Optional column — self-heals if absent.
    if (patch.interpretation_text !== undefined) {
      const { data: cur } = await db.from("as_operates_interpretations").select("interpretation_text").eq("id", id).maybeSingle();
      const prior = cur?.interpretation_text ?? "";
      if (prior && prior !== patch.interpretation_text) patch.previous_interpretation_text = prior;
    }
    let upd = await db.from("as_operates_interpretations").update(patch).eq("id", id);
    if (upd.error && /previous_interpretation_text/.test(upd.error.message || "")) {
      const { previous_interpretation_text: _p, ...noPrev } = patch;
      upd = await db.from("as_operates_interpretations").update(noPrev).eq("id", id);
    }
    if (upd.error) return json({ error: upd.error.message }, 500);
    return json({ ok: true });
  }

  if (action === "getInterpretations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const documentVersionId = String(body.documentVersionId ?? "").trim();
    if (!documentVersionId) return json({ error: "documentVersionId required" }, 400);

    // `*` includes the optional previous_interpretation_text column when present
    // (and simply omits it otherwise — no schema-cache error).
    const { data: interps, error } = await db.from("as_operates_interpretations")
      .select(`
        *,
        clause:clause_id(id,standard_version_id,clause_ref,clause_title,clause_text,requirement_type,
          standard:standard_version_id(standard:standard_id(code,title)))
      `).eq("document_version_id", documentVersionId).order("updated_at", { ascending: false });

    if (error) return json({ error: error.message }, 500);
    return json({ interpretations: interps ?? [] });
  }

  if (action === "getClausesForStandard") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const standardVersionId = String(body.standardVersionId ?? "").trim();
    if (!standardVersionId) return json({ error: "standardVersionId required" }, 400);

    const { data: clauses, error } = await db.from("standard_clauses")
      .select("*").eq("standard_version_id", standardVersionId).order("sort_order").order("clause_ref");

    if (error) return json({ error: error.message }, 500);
    return json({ clauses: clauses ?? [] });
  }

  if (action === "complianceMatrix") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    // Returns: [document_version rows] × [clause rows] with interpretation status cells
    const documentVersionIds = Array.isArray(body.documentVersionIds) ? body.documentVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    const standardVersionIds = Array.isArray(body.standardVersionIds) ? body.standardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];

    if (!documentVersionIds.length && !standardVersionIds.length) {
      return json({ error: "Provide documentVersionIds or standardVersionIds" }, 400);
    }

    let docsQ = db.from("document_versions").select("id,version,file_name,document_id,document:document_id(name)");
    if (documentVersionIds.length) {
      docsQ = docsQ.in("id", documentVersionIds);
    } else {
      docsQ = docsQ.limit(50); // default limit
    }
    const { data: docs } = await docsQ;

    let clausesQ = db.from("standard_clauses").select("id,standard_version_id,clause_ref,clause_title");
    if (standardVersionIds.length) {
      clausesQ = clausesQ.in("standard_version_id", standardVersionIds);
    } else {
      clausesQ = clausesQ.limit(100); // default limit
    }
    const { data: clauses } = await clausesQ.order("sort_order").order("clause_ref");

    const docIds = (docs ?? []).map((d) => d.id);
    const clauseIds = (clauses ?? []).map((c) => c.id);

    let matrix: any[] = [];
    if (docIds.length && clauseIds.length) {
      const { data: interps } = await db.from("as_operates_interpretations")
        .select("clause_id,document_version_id,compliance_status,reviewed_by,ai_generated")
        .in("document_version_id", docIds)
        .in("clause_id", clauseIds);

      // Build matrix: each cell is { clause_id, doc_id, status, reviewed, ai_gen }
      matrix = clauseIds.flatMap((cid) =>
        docIds.map((did) => {
          const interp = (interps ?? []).find((i) => i.clause_id === cid && i.document_version_id === did);
          return {
            clause_id: cid,
            document_version_id: did,
            status: interp?.compliance_status ?? "pending",
            reviewed_by: interp?.reviewed_by ?? null,
            ai_generated: interp?.ai_generated ?? false,
          };
        })
      );
    }

    return json({ docs: docs ?? [], clauses: clauses ?? [], matrix });
  }

  if (action === "exportProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const passportId = String(body.passportId ?? "").trim();
    const format = String(body.format ?? "json").toLowerCase();
    if (!passportId) return json({ error: "passportId required" }, 400);
    if (!["json", "json-ld", "pdf-data"].includes(format)) return json({ error: "format must be json|json-ld|pdf-data" }, 400);

    const { data: passport } = await db.from("product_passports").select("*").eq("id", passportId).maybeSingle();
    if (!passport) return json({ error: "Passport not found" }, 404);

    // Fetch all linked interpretations
    const { data: links } = await db.from("passport_interpretation_links")
      .select("interpretation:interpretation_id(*, clause:clause_id(*, standard:standard_version_id(*, standard:standard_id(code,title))))")
      .eq("passport_id", passportId);

    const applicableStandards = (passport.applicable_standards || []) as any[];
    const sustainabilityData = (passport.sustainability_data || {}) as Record<string, unknown>;

    if (format === "json-ld") {
      // schema.org/Product + ESPR extensions
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: passport.product_name,
        model: passport.product_model || undefined,
        manufacturer: {
          "@type": "Organization",
          name: passport.manufacturer,
        },
        gtin: passport.gtin || undefined,
        description: `EU Product Passport for ${passport.product_name}`,
        conformity: {
          "@context": "https://espr.example.org",
          "declaration_of_conformity_ref": passport.declaration_of_conformity_ref || "",
          "applicable_standards": applicableStandards,
        },
        sustainability: sustainabilityData,
        compliance_interpretations: (links ?? []).map((l: any) => {
          const i = l.interpretation;
          const c = i?.clause;
          return {
            clause_ref: c?.clause_ref,
            standard: c?.standard?.code,
            status: i?.compliance_status,
            interpretation: i?.interpretation_text,
            reviewed_by: i?.reviewed_by,
          };
        }),
        dateModified: passport.updated_at,
        datePublished: passport.valid_from,
        validUntil: passport.valid_to,
      };
      return json({ format: "json-ld", data: jsonLd });
    }

    if (format === "pdf-data") {
      // Simple JSON that can be embedded in PDF metadata
      return json({
        format: "pdf-data",
        product: {
          name: passport.product_name,
          model: passport.product_model,
          manufacturer: passport.manufacturer,
          gtin: passport.gtin,
          doc_ref: passport.declaration_of_conformity_ref,
        },
        standards: applicableStandards,
        sustainability: sustainabilityData,
        valid_from: passport.valid_from,
        valid_to: passport.valid_to,
      });
    }

    // Default: json
    return json({
      format: "json",
      passport: {
        id: passport.id,
        product_name: passport.product_name,
        product_model: passport.product_model,
        manufacturer: passport.manufacturer,
        gtin: passport.gtin,
        applicable_standards: applicableStandards,
        sustainability_data: sustainabilityData,
        status: passport.passport_status,
        valid_from: passport.valid_from,
        valid_to: passport.valid_to,
      },
      compliance_data: (links ?? []).length > 0 ? (links ?? []).map((l: any) => {
        const i = l.interpretation;
        const c = i?.clause;
        return {
          clause: c?.clause_ref,
          standard: c?.standard?.code,
          status: i?.compliance_status,
          interpretation: i?.interpretation_text,
        };
      }) : "No interpretations linked",
    });
  }

  // --- Product passports: management (Rushroom only) ----------------------
  if (action === "listProductPassports") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const { data, error } = await db.from("product_passports").select("*").order("created_at", { ascending: false });
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The Level 2 tables aren't set up yet — run the account/Level-2 SQL first." : error.message }, 500);
    // Attach a link count so the list can show how many interpretations each carries.
    const ids = (data ?? []).map((p) => p.id);
    const counts: Record<string, number> = {};
    if (ids.length) {
      const { data: links } = await db.from("passport_interpretation_links").select("passport_id").in("passport_id", ids);
      for (const l of links ?? []) counts[l.passport_id] = (counts[l.passport_id] || 0) + 1;
    }
    return json({ passports: (data ?? []).map((p) => ({ ...p, link_count: counts[p.id] || 0 })) });
  }
  if (action === "getProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    if (!id) return json({ error: "id required" }, 400);
    const { data: passport } = await db.from("product_passports").select("*").eq("id", id).maybeSingle();
    if (!passport) return json({ error: "Passport not found" }, 404);
    const { data: links } = await db.from("passport_interpretation_links")
      .select("id, relevance_note, interpretation:interpretation_id(id, compliance_status, interpretation_text, document_version_id, clause:clause_id(clause_ref, clause_title, standard:standard_version_id(standard:standard_id(code,title))))")
      .eq("passport_id", id);
    return json({ passport, links: links ?? [] });
  }
  if (action === "createProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const product_name = String(body.productName ?? "").trim();
    if (!product_name) return json({ error: "productName required" }, 400);
    const row: Record<string, unknown> = {
      product_name: product_name.slice(0, 300),
      product_model: String(body.productModel ?? "").slice(0, 200),
      manufacturer: (String(body.manufacturer ?? "").trim() || "Rushroom AB").slice(0, 200),
      gtin: String(body.gtin ?? "").slice(0, 60),
      declaration_of_conformity_ref: String(body.declarationOfConformityRef ?? "").slice(0, 300),
    };
    const { data, error } = await db.from("product_passports").insert(row).select("id").maybeSingle();
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The Level 2 tables aren't set up yet — run the SQL first." : error.message }, 500);
    return json({ ok: true, id: data?.id });
  }
  if (action === "updateProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    if (!id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.productName !== undefined) patch.product_name = String(body.productName).slice(0, 300);
    if (body.productModel !== undefined) patch.product_model = String(body.productModel).slice(0, 200);
    if (body.manufacturer !== undefined) patch.manufacturer = String(body.manufacturer).slice(0, 200);
    if (body.gtin !== undefined) patch.gtin = String(body.gtin).slice(0, 60);
    if (body.declarationOfConformityRef !== undefined) patch.declaration_of_conformity_ref = String(body.declarationOfConformityRef).slice(0, 300);
    if (body.passportStatus !== undefined) {
      if (!["draft", "active", "superseded"].includes(String(body.passportStatus))) return json({ error: "Invalid passportStatus" }, 400);
      patch.passport_status = String(body.passportStatus);
    }
    if (body.validFrom !== undefined) patch.valid_from = String(body.validFrom).slice(0, 40) || null;
    if (body.validTo !== undefined) patch.valid_to = String(body.validTo).slice(0, 40) || null;
    if (body.sustainabilityData !== undefined && typeof body.sustainabilityData === "object") patch.sustainability_data = body.sustainabilityData;
    if (body.applicableStandards !== undefined && Array.isArray(body.applicableStandards)) patch.applicable_standards = body.applicableStandards;
    const { error } = await db.from("product_passports").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "deleteProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    if (!id) return json({ error: "id required" }, 400);
    const { error } = await db.from("product_passports").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "linkPassportInterpretation") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const passport_id = String(body.passportId ?? "").trim();
    const interpretation_id = String(body.interpretationId ?? "").trim();
    if (!passport_id || !interpretation_id) return json({ error: "passportId and interpretationId required" }, 400);
    const { error } = await db.from("passport_interpretation_links")
      .upsert({ passport_id, interpretation_id, relevance_note: String(body.relevanceNote ?? "").slice(0, 500) }, { onConflict: "passport_id,interpretation_id", ignoreDuplicates: true });
    if (error && error.code !== "23505") return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "unlinkPassportInterpretation") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const passport_id = String(body.passportId ?? "").trim();
    const interpretation_id = String(body.interpretationId ?? "").trim();
    if (!passport_id || !interpretation_id) return json({ error: "passportId and interpretationId required" }, 400);
    const { error } = await db.from("passport_interpretation_links").delete().eq("passport_id", passport_id).eq("interpretation_id", interpretation_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
