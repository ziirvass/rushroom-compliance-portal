/**
 * Rushroom Compliance Portal — migrate the document library from Google Drive
 * into Supabase Storage, and replace the Drive links with the in-house files.
 *
 * It streams each file Drive → Supabase directly (nothing huge is held in memory).
 * Google Docs are exported to .docx and Google Sheets to .xlsx so they stay
 * editable off Google; the existing PDF is copied as-is.
 *
 * PREREQUISITES
 *   1. Supabase project created and schema.sql run (so the `documents` table and
 *      `documents` bucket exist).
 *   2. Each Google file below is shared "Anyone with the link → Viewer" (the
 *      export download needs that; the script tells you which ones aren't).
 *   3. Node 18+ (uses global fetch).
 *
 * RUN
 *   cd migration
 *   npm install
 *   SUPABASE_URL="https://<ref>.supabase.co" \
 *   SUPABASE_SERVICE_KEY="<service-role key from Project Settings → API>" \
 *   node migrate-docs.mjs
 *
 * Safe to re-run: it upserts files and replaces the matching library rows.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = "documents";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables. See header.");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// kind: "doc" (Google Doc → .docx) | "sheet" (Google Sheet → .xlsx) | "pdf" (binary)
const DOCS = [
  { id: "1x5Llp1rEulCz_-7LtMBHT8wb6uVGpGhFeB03Q-63CnU", kind: "doc",   category: "Declarations & CE",     name: "EU Declaration of Conformity (template)",                       audience: ["internal", "reviewer"] },
  { id: "1ywY9J9Fgfl4_ExBdFA9gQwt3AkqABw8xz48KVbYaH0Y", kind: "doc",   category: "Declarations & CE",     name: "CE marking specification",                                     audience: ["internal", "supplier", "reviewer"] },
  { id: "1Px8WdhGTlwEWB0mkYJc_0bTBbZp-PRTniUdXiTBAnzE", kind: "doc",   category: "Declarations & CE",     name: "PPWR Declaration of Conformity (reusable packaging)",           audience: ["internal"] },
  { id: "14vnhdLBOU_3gZToVHy_soRX1HqZvmgvmXAadoSGO6TM", kind: "doc",   category: "Technical file",        name: "Technical File index (template)",                              audience: ["internal", "reviewer"] },
  { id: "1e_Hvhyp50ST9l4NOG0A07Qy6b6xlDKJ2nLfV4GAzunc", kind: "doc",   category: "Technical file",        name: "Compliance Audit File — README / map",                         audience: ["internal"] },
  { id: "1W2BLk_gWH0QVZaN-zNdXnJ31ODC3trK0myIQNdJQAzk", kind: "sheet", category: "Technical file",        name: "Compliance Documentation Register",                            audience: ["internal", "reviewer"] },
  { id: "1pXOt6Ol4MwmjvblUSY03vSpv9naXZ3GW",             kind: "pdf",   category: "Test reports",          name: "LVD / safety test report (IOS-PRF0032, AA-86878-25)",           audience: ["internal", "reviewer"] },
  { id: "1MNxJ_uByom-XcrnvrzbjyKhYbwEeD7gHmB0Kne9es4U", kind: "doc",   category: "Suppliers",             name: "Supplier Declaration of Compliance (form)",                    audience: ["internal", "supplier"] },
  { id: "1Xz67mHsJ31HWQFXYLrn_xqkhhtxXZETun9f6jTk59JA", kind: "sheet", category: "Suppliers",             name: "Supplier Compliance Spec — LED strip & cabling/connectors",     audience: ["internal", "supplier"] },
  { id: "1eqPeMt8QpsYHEpW9bclvyHA6veaHqKmi0PwGcHetHpU", kind: "doc",   category: "Suppliers",             name: "Product Change Notification commitment (annex)",               audience: ["internal", "supplier"] },
  { id: "1rrWd76T6SvcHF985jWgDrT8tzPa2pZ54uXFoI9fLVP4", kind: "sheet", category: "Materials & packaging", name: "Packaging compliance checklist (reusable transport packaging)", audience: ["internal"] },
  { id: "1mKgXaBHHghEF3l-qR7tdDC5PnS5wpUEAkAWFqJb9kcM", kind: "sheet", category: "Records & monitoring",  name: "Records Retention Log",                                        audience: ["internal"] },
  { id: "1MO246WfK9Fnc7Es7-WZwAWwVvJrWkECXpEIJmVnIuS8", kind: "doc",   category: "Records & monitoring",  name: "Regulatory Watch — 2026-06",                                   audience: ["internal", "reviewer"] },
];

const KIND = {
  doc:   { ext: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
           url: (id) => `https://docs.google.com/document/d/${id}/export?format=docx` },
  sheet: { ext: "xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
           url: (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx` },
  pdf:   { ext: "pdf",  contentType: "application/pdf",
           url: (id) => `https://drive.google.com/uc?export=download&id=${id}` },
};

const slug = (s) => s.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

async function migrateOne(doc) {
  const k = KIND[doc.kind];
  const res = await fetch(k.url(doc.id), { redirect: "follow" });
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  if (ctype.includes("text/html")) throw new Error("got an HTML page, not the file — is it shared 'Anyone with the link → Viewer'?");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 100) throw new Error(`suspiciously small (${bytes.byteLength} bytes)`);

  const path = `${slug(doc.name)}.${k.ext}`;
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: k.contentType, upsert: true });
  if (up.error) throw new Error(`storage: ${up.error.message}`);

  // Replace any existing library row(s) with this name (e.g. the Drive-linked seed).
  await db.from("documents").delete().eq("name", doc.name);
  const ins = await db.from("documents").insert({
    category: doc.category, name: doc.name, url: "", storage_path: path, audience: doc.audience,
  });
  if (ins.error) throw new Error(`db insert: ${ins.error.message}`);
  return { path, size: bytes.byteLength };
}

let ok = 0, fail = 0;
for (const doc of DOCS) {
  try {
    const r = await migrateOne(doc);
    console.log(`✓ ${doc.name}  →  ${r.path} (${r.size} bytes)`);
    ok++;
  } catch (e) {
    console.error(`✗ ${doc.name}  —  ${e.message}`);
    fail++;
  }
}
console.log(`\nDone: ${ok} migrated, ${fail} failed.${fail ? " Share the failed files and re-run." : ""}`);
process.exit(fail ? 1 : 0);
