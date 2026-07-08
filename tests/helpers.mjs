// Reusable assertions for the portal-api harness.
//
// The centrepiece is the leakage assertion: given two authenticated sessions on
// opposite sides of an isolation boundary, no identifier owned by one may appear
// in the other's responses. In Stage 0 the boundary is the audience/tier model
// that already exists; from Stage 2 the same helper enforces cross-ORG isolation.

import assert from "node:assert/strict";
import { call } from "./config.mjs";

// Collect the set of row identifiers a session sees for a read action.
// `pick(json)` returns an array of ids from the response body.
export async function idsVisible(token, action, pick, body = {}) {
  const { json } = await call(action, { token, ...body });
  return new Set((pick(json) || []).filter((v) => v != null));
}

// The core leakage assertion — B must not see any id that A can see.
export function assertNoOverlap(aIds, bIds, label) {
  const leaked = [...aIds].filter((id) => bIds.has(id));
  assert.equal(
    leaked.length, 0,
    `${label}: ${leaked.length} identifier(s) crossed the isolation boundary` +
    (leaked.length ? ` — e.g. ${leaked.slice(0, 5).join(", ")}` : ""),
  );
}

// Assert a response is an authentication rejection (missing / invalid token).
export function assertAuthRejected(result, label) {
  const err = (result.json && result.json.error) || "";
  assert.ok(
    /auth|not authenticated|unauthor|token/i.test(err),
    `${label}: expected an auth rejection, got status=${result.status} body=${JSON.stringify(result.json)}`,
  );
}

// Convenience: a skip reason string when required env vars are missing.
export function need(vars) {
  const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
  return missing.length ? `set ${missing.join(", ")} to run this test` : false;
}
