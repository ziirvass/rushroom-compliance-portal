// Baseline smoke tests — always active, no credentials required.
// They lock in the two invariants every later stage must preserve:
//   1. the function is reachable and speaks JSON;
//   2. protected actions are rejected before any data is returned (the auth gate
//      runs ahead of action dispatch).

import { test } from "node:test";
import assert from "node:assert/strict";
import { API_URL, call } from "./config.mjs";
import { assertAuthRejected } from "./helpers.mjs";

test("portal-api is reachable and returns a JSON body", async () => {
  const { status, json } = await call("__health_probe__");
  assert.ok(json !== null, `expected JSON from ${API_URL} (status ${status})`);
});

test("a protected action without a token is rejected (auth gate)", async () => {
  assertAuthRejected(await call("data"), "data without token");
});

test("a second protected action without a token is rejected", async () => {
  assertAuthRejected(await call("listRequirementLinksQueue", { statuses: ["proposed"] }), "queue without token");
});

test("an invalid token never yields a 200", async () => {
  // Bad token → rejected before dispatch. Guards the gate-ordering contract.
  const r = await call("data", { token: "not.a.valid.token" });
  assert.notEqual(r.status, 200, `invalid token returned 200: ${JSON.stringify(r.json)}`);
  assertAuthRejected(r, "data with invalid token");
});

test("the tenant is never taken from the request body (contract note)", async () => {
  // A forged organization_id in the payload must have no effect: with no token
  // the request is still auth-rejected, i.e. the body cannot smuggle tenancy.
  // From Stage 2 this expands to: an authenticated session's org is session-
  // derived and a body organization_id is ignored.
  const r = await call("data", { organization_id: "11111111-1111-1111-1111-111111111111" });
  assertAuthRejected(r, "data with forged organization_id and no token");
});
