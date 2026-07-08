// Stage 2 — tenant scoping is enforced without breaking the seed tenant's reads.
//
// The risk of central scoping is that a bad filter returns nothing. These checks
// log in and confirm the org-scoped read paths still succeed (no error, arrays
// returned) for the seed organization. They need TEST_RUSHROOM_PASSWORD and so
// skip otherwise. The cross-ORG leakage proof lives in cross-tenant.test.mjs and
// activates once a second org is provisioned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDS, call, loginShared } from "./config.mjs";
import { need } from "./helpers.mjs";

const rushSkip = need({ TEST_RUSHROOM_PASSWORD: CREDS.rushroomPassword });

test("scoped read: data returns the tenant's action plan + documents without error",
  { skip: rushSkip }, async () => {
    const token = await loginShared("rushroom", CREDS.rushroomPassword);
    const { json } = await call("data", { token });
    assert.ok(json && !json.error, `data errored: ${JSON.stringify(json)}`);
    assert.ok(Array.isArray(json.steps), "expected steps[] in the scoped response");
    assert.ok(Array.isArray(json.documents), "expected documents[] in the scoped response");
  });

test("scoped read: standards returns without error",
  { skip: rushSkip }, async () => {
    const token = await loginShared("rushroom", CREDS.rushroomPassword);
    const { json } = await call("standards", { token });
    assert.ok(json && !json.error, `standards errored: ${JSON.stringify(json)}`);
    assert.ok(Array.isArray(json.standards), "expected standards[] in the scoped response");
  });

test("scoped write path is org-stamped: a supplier upload path is tenant-prefixed",
  { skip: need({ TEST_SUPPLIER_PASSWORD: CREDS.supplierPassword }) }, async () => {
    const token = await loginShared("supplier", CREDS.supplierPassword);
    const { json } = await call("uploadUrl", { token, fileName: "isolation-probe.txt" });
    assert.ok(json && json.path, `uploadUrl gave no path: ${JSON.stringify(json)}`);
    // Path must start with a uuid/ prefix (the tenant), then role/, then file.
    assert.match(json.path, /^[0-9a-f-]{36}\/(supplier|rushroom)\//i,
      `upload path is not tenant-prefixed: ${json.path}`);
  });
