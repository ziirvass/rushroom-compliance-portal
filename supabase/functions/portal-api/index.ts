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

// ---- Google Docs integration (service-account OAuth) ----------------------
const GOOGLE_SERVICE_ACCOUNT = Deno.env.get("GOOGLE_SERVICE_ACCOUNT") ?? "";
// A bare service account has no Drive storage, so it cannot own Docs. Set this
// to a real user's email (with domain-wide delegation authorised in Google
// Workspace) to impersonate them — the Doc is then created in THEIR Drive.
const GOOGLE_IMPERSONATE_SUBJECT = Deno.env.get("GOOGLE_IMPERSONATE_SUBJECT") ?? "";

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Mint a short-lived Google OAuth access token from the service-account JSON
// (signs a JWT with the SA private key, then exchanges it at the token endpoint).
async function googleAccessToken(scopes: string[]): Promise<string> {
  if (!GOOGLE_SERVICE_ACCOUNT) throw new Error("GOOGLE_SERVICE_ACCOUNT secret is not set");
  let sa: any;
  try { sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT); }
  catch { throw new Error("GOOGLE_SERVICE_ACCOUNT is not valid JSON"); }
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT is missing client_email or private_key");
  const now = Math.floor(Date.now() / 1000);
  const enc64 = (obj: unknown) => b64url(enc.encode(JSON.stringify(obj)));
  const claim: Record<string, unknown> = {
    iss: sa.client_email, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  };
  if (GOOGLE_IMPERSONATE_SUBJECT) claim.sub = GOOGLE_IMPERSONATE_SUBJECT; // domain-wide delegation
  const signingInput = `${enc64({ alg: "RS256", typ: "JWT" })}.${enc64(claim)}`;
  const pem = String(sa.private_key).replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", ab(b64decode(pem)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, ab(enc.encode(signingInput))));
  const jwt = `${signingInput}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
  return data.access_token as string;
}

// Flatten a Google Doc's structured body into plain text (paragraphs + tables).
function extractGoogleDocText(doc: any): string {
  const parts: string[] = [];
  const runElements = (elements: any[]) => { for (const pe of elements || []) if (pe.textRun?.content) parts.push(pe.textRun.content); };
  for (const el of doc.body?.content || []) {
    if (el.paragraph) runElements(el.paragraph.elements);
    else if (el.table) {
      for (const row of el.table.tableRows || []) {
        const cells = (row.tableCells || []).map((c: any) => {
          const cp: string[] = [];
          for (const cc of c.content || []) if (cc.paragraph) for (const pe of cc.paragraph.elements || []) if (pe.textRun?.content) cp.push(pe.textRun.content);
          return cp.join("").trim();
        });
        parts.push(cells.join("\t") + "\n");
      }
    }
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- AI deviation monitoring (Claude) ----
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SCAN_MODEL = "claude-opus-4-8";
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
    version: { type: "string" },
    effective_date: { type: "string" },
    summary: { type: "string" },
  },
  required: ["code", "title", "category", "version", "effective_date", "summary"],
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
        await db.from("document_versions").insert({
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

    const name = String(body.name ?? "").trim() || `${templateDoc.name || "Template"} — As Operates`;
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
      await db.from("document_versions").insert({
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
      const name = String(body.newDocumentName ?? "").trim() || "New As Operates";
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

    const { error: insertErr } = await db.from("document_versions").insert({
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
    const { error } = await db.from("document_versions").insert({
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
    const { data, error } = await db.from("standards").insert({
      code: code.slice(0, 120), title: title.slice(0, 300), category: String(body.category ?? "").slice(0, 80), audience,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data?.id });
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
    const { error } = await db.from("standard_versions").insert({
      standard_id,
      version: String(body.version ?? "").slice(0, 80),
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
- category: a short classifying tag for a compliance register — one of LVD, EMC, RoHS, REACH, Ecodesign, Energy labelling, Packaging/PPWR, WEEE, Batteries, Radio/RED, CPR, Machinery, or another concise domain tag if none fit.
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
      version: String(parsed.version || ""),
      effectiveDate: String(parsed.effective_date || ""),
      summary: String(parsed.summary || ""),
    });
  }

  if (action === "createGoogleDoc") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const draftText = String(body.draftText ?? "");
    const documentName = (String(body.documentName ?? "").trim() || "Rushroom compliance draft").slice(0, 300);
    try {
      const gToken = await googleAccessToken([
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive",
      ]);
      // 1. create an empty document with the given title
      const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
        method: "POST",
        headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: documentName }),
      });
      const doc = await createRes.json();
      if (!createRes.ok) return json({ error: `Google Docs create failed: ${doc.error?.message || createRes.status}` }, 502);
      const googleDocId = doc.documentId as string;
      // 2. insert the draft text at the start of the body
      if (draftText.trim()) {
        const upd = await fetch(`https://docs.googleapis.com/v1/documents/${googleDocId}:batchUpdate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: draftText } }] }),
        });
        if (!upd.ok) { const e = await upd.json(); return json({ error: `Google Docs insert failed: ${e.error?.message || upd.status}` }, 502); }
      }
      // 3. share: anyone with the link can edit
      const perm = await fetch(`https://www.googleapis.com/drive/v3/files/${googleDocId}/permissions?supportsAllDrives=true`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "writer", type: "anyone" }),
      });
      if (!perm.ok) { const e = await perm.json().catch(() => ({})); return json({ error: `Google Drive share failed: ${e.error?.message || perm.status}` }, 502); }
      const editUrl = `https://docs.google.com/document/d/${googleDocId}/edit`;
      return json({ ok: true, googleDocId, editUrl, webViewLink: editUrl });
    } catch (e) {
      return json({ error: `Google Docs error: ${(e as Error).message}` }, 502);
    }
  }

  if (action === "fetchGoogleDocContent") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const googleDocId = String(body.googleDocId ?? "").trim();
    if (!googleDocId) return json({ error: "googleDocId required" }, 400);
    try {
      const gToken = await googleAccessToken(["https://www.googleapis.com/auth/documents.readonly"]);
      const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(googleDocId)}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      const doc = await res.json();
      if (!res.ok) return json({ error: `Google Docs fetch failed: ${doc.error?.message || res.status}` }, 502);
      return json({ ok: true, content: extractGoogleDocText(doc), lastModified: doc.revisionId || "" });
    } catch (e) {
      return json({ error: `Google Docs error: ${(e as Error).message}` }, 502);
    }
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
    const { data: scan } = await db.from("deviation_scans").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!scan) return json({ scan: null, findings: [] });
    const { data: findings } = await db.from("deviation_findings").select("*").eq("scan_id", scan.id);
    return json({ scan, findings: findings ?? [] });
  }

  if (action === "runDeviationScan") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);

    // Standards: latest version of each.
    const { data: stds } = await db.from("standards").select("id,code,title,category").order("code");
    const standards: any[] = [];
    for (const s of stds ?? []) {
      const { data: v } = await db.from("standard_versions").select("*").eq("standard_id", s.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (v?.storage_path) standards.push({ ...s, version: v.version, storage_path: v.storage_path, file_name: v.file_name });
    }
    // Only the operational ("Company as Operates") documents are audited — the
    // templates/requirements are the inputs, not the evidence being checked.
    const { data: docs } = await db.from("documents").select("name,storage_path").eq("kind", "operational").neq("storage_path", "");
    const storedDocs = (docs ?? []).filter((d) => d.storage_path);
    if (!standards.length) return json({ error: "No standards with an uploaded version yet — add standards and upload files first." }, 400);
    if (!storedDocs.length) return json({ error: "No operational documents to check — mark documents as “Company as Operates” in the Document library first." }, 400);

    const content: any[] = [{ type: "text", text: "=== STANDARDS & REGULATIONS (the requirements) ===" }];
    for (const s of standards) {
      content.push({ type: "text", text: `\n--- STANDARD: ${s.code}${s.title ? ` — ${s.title}` : ""}${s.category ? ` [${s.category}]` : ""} (version ${s.version || "?"}) ---` });
      content.push(await fileBlock(STD_BUCKET, s.storage_path, s.file_name));
    }
    content.push({ type: "text", text: "\n\n=== COMPLIANCE DOCUMENTS (what Rushroom has produced) ===" });
    for (const d of storedDocs) {
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

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to complete the analysis (refusal)." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed (it may have been truncated). Try again." }, 502); }

    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const counts: Record<string, number> = {};
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

    const { data: scan, error: scanErr } = await db.from("deviation_scans").insert({
      model: apiJson.model || SCAN_MODEL, status: "ok", summary: String(parsed.summary || "").slice(0, 4000),
      counts, docs_scanned: storedDocs.length, standards_scanned: standards.length,
    }).select("*").maybeSingle();
    if (scanErr || !scan) return json({ error: `Could not save scan: ${scanErr?.message}` }, 500);

    if (findings.length) {
      const rows = findings.slice(0, 200).map((f: any) => ({
        scan_id: scan.id,
        severity: SEVERITIES.includes(f.severity) ? f.severity : "Info",
        title: String(f.title || "").slice(0, 300),
        description: String(f.description || "").slice(0, 4000),
        document: String(f.document || "").slice(0, 300),
        standard: String(f.standard || "").slice(0, 300),
        recommendation: String(f.recommendation || "").slice(0, 2000),
      }));
      const { error: fErr } = await db.from("deviation_findings").insert(rows);
      if (fErr) return json({ error: `Could not save findings: ${fErr.message}` }, 500);
    }
    return json({ ok: true, scan, findings });
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

  return json({ error: `Unknown action: ${action}` }, 400);
});
