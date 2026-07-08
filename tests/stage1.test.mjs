// Stage 1 — tenant-aware session contract.
//
// Verifies the new orgContext action: it requires auth (always-on), and the
// caller's organization is taken from the SESSION, never from the request body
// (a forged organization_id must have no effect). The authenticated assertions
// need a login and so skip without TEST_RUSHROOM_PASSWORD.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDS, call, loginShared } from "./config.mjs";
import { assertAuthRejected, need } from "./helpers.mjs";

const SEED_ORG_ID = "11111111-1111-4111-8111-111111111111";

test("orgContext requires authentication", async () => {
  assertAuthRejected(await call("orgContext"), "orgContext without token");
});

const rushSkip = need({ TEST_RUSHROOM_PASSWORD: CREDS.rushroomPassword });

test("orgContext returns a tenant for an authenticated session", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("orgContext", { token });
  assert.ok(json && json.organization_id, `expected an organization_id, got ${JSON.stringify(json)}`);
});

test("orgContext is session-derived — a forged body organization_id is ignored",
  { skip: rushSkip }, async () => {
    const token = await loginShared("rushroom", CREDS.rushroomPassword);
    const honest = (await call("orgContext", { token })).json;
    const forged = (await call("orgContext", { token, organization_id: "22222222-2222-4222-8222-222222222222" })).json;
    assert.equal(forged.organization_id, honest.organization_id,
      "a body organization_id changed the resolved tenant — it must come only from the session");
  });

test("orgContext for the bootstrap login resolves to the seed organization",
  { skip: rushSkip }, async () => {
    const token = await loginShared("rushroom", CREDS.rushroomPassword);
    const { json } = await call("orgContext", { token });
    assert.equal(json.organization_id, SEED_ORG_ID,
      `bootstrap session should map to the seed org ${SEED_ORG_ID}, got ${json.organization_id}`);
  });
