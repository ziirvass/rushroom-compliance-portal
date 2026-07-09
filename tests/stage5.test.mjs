// Stage 5 — MFA (TOTP) contracts + DB hardening surface.
//
// Always-on: MFA self-service is auth-gated. Credentialed (the shared/bootstrap
// login has no individual user id): MFA reports "not available" and enrolment is
// refused — proving MFA is scoped to individual accounts and that existing
// (shared) logins are unaffected. Full TOTP enrol/verify needs an individual
// account with an authenticator and is exercised manually.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDS, call, loginShared } from "./config.mjs";
import { assertAuthRejected, need } from "./helpers.mjs";

test("MFA self-service requires authentication", async () => {
  assertAuthRejected(await call("mfaStatus"), "mfaStatus without token");
  assertAuthRejected(await call("mfaEnrollStart"), "mfaEnrollStart without token");
});

const rushSkip = need({ TEST_RUSHROOM_PASSWORD: CREDS.rushroomPassword });

test("MFA is not available for the shared/bootstrap login (no user id)", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("mfaStatus", { token });
  assert.equal(json.available, false, "shared login must report MFA as unavailable");
  assert.equal(json.enabled, false, "shared login can't have MFA enabled");
});

test("MFA enrolment is refused for the shared/bootstrap login", { skip: rushSkip }, async () => {
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const { json } = await call("mfaEnrollStart", { token });
  assert.ok(json && json.error, "shared login should be refused MFA enrolment");
});
