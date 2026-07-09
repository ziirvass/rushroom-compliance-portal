// Stage 4 — plan entitlements, usage metering, AI caps, billing.
//
// Always-on: orgBilling is auth-gated; the billing webhook rejects unauthorised
// callers. Credentialed (the operator/seed org, plan=internal): billing reports
// an unlimited plan with every feature — proving the entitlement engine reads
// the plan and that the operator is never capped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDS, call, loginShared } from "./config.mjs";
import { assertAuthRejected, need } from "./helpers.mjs";

test("orgBilling requires authentication", async () => {
  assertAuthRejected(await call("orgBilling"), "orgBilling without token");
});

test("the billing webhook rejects unauthorised callers", async () => {
  // With no/incorrect secret it must never mutate: expect a non-200 error body
  // (404 when unconfigured, 403 when the secret is wrong).
  const r = await call("billingWebhook", { organizationId: "11111111-1111-4111-8111-111111111111", plan: "enterprise" });
  assert.notEqual(r.status, 200, `webhook accepted an unauthorised call: ${JSON.stringify(r.json)}`);
  assert.ok(r.json && r.json.error, "expected an error body from an unauthorised webhook call");
});

const rushSkip = need({ TEST_RUSHROOM_PASSWORD: CREDS.rushroomPassword });

test("orgBilling reports the operator's unlimited plan with all features", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("orgBilling", { token });
  assert.ok(json && json.plan, `expected a plan, got ${JSON.stringify(json)}`);
  assert.equal(json.ai.limit, null, "operator org must have an uncapped AI limit");
  assert.ok(Array.isArray(json.features) && json.features.includes("cellar"), "operator plan should include every feature");
  assert.ok(Array.isArray(json.plans) && json.plans.length >= 4, "expected the plan catalogue");
});

test("orgBilling exposes current-period AI usage (a number)", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("orgBilling", { token });
  assert.equal(typeof json.ai.used, "number", "ai.used should be a number");
  assert.match(json.period, /^\d{4}-\d{2}$/, "period should be YYYY-MM");
});
