// Central config for the portal-api test harness (Stage 0).
//
// No secrets are hardcoded. The function URL defaults to the public production
// endpoint (already exposed in assets/config.js) so the read-only, UNAUTHENTICATED
// smoke tests can run anywhere. Point PORTAL_API_URL at a staging function to
// avoid touching production. Credentialed/isolation tests only run when the
// relevant env vars are set — otherwise they skip, so a fresh checkout and CI
// stay green without any secrets.

export const API_URL = process.env.PORTAL_API_URL
  || "https://iwoqujpwhsoywudjtsnj.supabase.co/functions/v1/portal-api";

export const CREDS = {
  // Shared-password role logins → the Stage 0 baseline (audience/tier isolation).
  rushroomPassword: process.env.TEST_RUSHROOM_PASSWORD || "",
  supplierPassword: process.env.TEST_SUPPLIER_PASSWORD || "",
  // Two-tenant accounts for the true cross-org harness (enabled from Stage 1–2,
  // once the Organization model exists). Until then these tests skip regardless.
  orgAEmail: process.env.TEST_ORG_A_EMAIL || "",
  orgAPassword: process.env.TEST_ORG_A_PASSWORD || "",
  orgBEmail: process.env.TEST_ORG_B_EMAIL || "",
  orgBPassword: process.env.TEST_ORG_B_PASSWORD || "",
};

// Low-level call to the action router. Returns { status, json } and never throws
// on a non-2xx (the tests assert on status/body themselves).
export async function call(action, body = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

// Shared-password login → session token (Stage 0). role: "rushroom" | "supplier".
export async function loginShared(role, password) {
  const { json } = await call("login", { role, password });
  if (!json || !json.token) throw new Error(`login failed for role=${role}: ${json && json.error}`);
  return json.token;
}

// Individual account login → full session payload (used by the two-org harness).
export async function loginUser(email, password) {
  const { json } = await call("loginUser", { email, password });
  if (!json || !json.token) throw new Error(`loginUser failed for ${email}: ${json && json.error}`);
  return json;
}
