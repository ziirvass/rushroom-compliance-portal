// Stage 3 — organization management + admin console + impersonation contracts.
//
// Always-on: the platform/operator actions are auth-gated. Credentialed (the
// rushroom bootstrap = platform owner of the seed org): orgContext reports
// platform_owner, the tenants list includes the seed org, and org members load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDS, call, loginShared } from "./config.mjs";
import { assertAuthRejected, need } from "./helpers.mjs";

const SEED_ORG_ID = "11111111-1111-4111-8111-111111111111";

test("platform actions require authentication", async () => {
  assertAuthRejected(await call("platformTenants"), "platformTenants without token");
  assertAuthRejected(await call("orgMembers"), "orgMembers without token");
  assertAuthRejected(await call("platformImpersonate", { organizationId: SEED_ORG_ID }), "impersonate without token");
});

const rushSkip = need({ TEST_RUSHROOM_PASSWORD: CREDS.rushroomPassword });

test("orgContext reports platform_owner for the operator (seed) admin", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("orgContext", { token });
  assert.equal(json.platform_owner, true, `expected platform_owner=true, got ${JSON.stringify(json)}`);
});

test("platformTenants lists organizations including the seed org", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("platformTenants", { token });
  assert.ok(json && Array.isArray(json.tenants), `expected tenants[], got ${JSON.stringify(json)}`);
  assert.ok(json.tenants.some((t) => t.id === SEED_ORG_ID && t.is_seed), "seed org missing or not flagged as operator");
});

test("orgMembers returns the caller org's members", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("orgMembers", { token });
  assert.ok(json && Array.isArray(json.members), `expected members[], got ${JSON.stringify(json)}`);
});

test("the operator organization cannot be suspended", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("platformSetTenantStatus", { token, organizationId: SEED_ORG_ID, status: "suspended" });
  assert.ok(json && json.error, "expected the seed org to be protected from suspension");
});
