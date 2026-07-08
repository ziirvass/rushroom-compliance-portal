// Cross-tenant leakage harness.
//
// Today the portal is single-tenant, so the isolation boundary that exists is
// the AUDIENCE/TIER model: a supplier-tier session must only ever receive
// supplier-audience rows. Stage 0 asserts that baseline (the direct precursor to
// tenant isolation). The true two-ORG harness is written below but skips until
// the Organization model lands (Stage 1) and scoping is enforced (Stage 2) — at
// which point the same assertNoOverlap contract is switched on for every
// tenant-scoped read action.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDS, call, loginShared, loginUser } from "./config.mjs";
import { idsVisible, assertNoOverlap, need } from "./helpers.mjs";

/* -------------------- Stage 0 baseline: audience isolation -------------------- */

const suppSkip = need({ TEST_SUPPLIER_PASSWORD: CREDS.supplierPassword });

test("baseline: a supplier session only receives supplier-audience documents",
  { skip: suppSkip }, async () => {
    const supp = await loginShared("supplier", CREDS.supplierPassword);
    const { json } = await call("data", { token: supp });
    const nonSupplier = (json.documents || []).filter((d) => !(d.audience || []).includes("supplier"));
    assert.equal(nonSupplier.length, 0,
      `supplier received ${nonSupplier.length} non-supplier-audience document(s)`);
  });

test("baseline: a supplier session only receives supplier-audience action items",
  { skip: suppSkip }, async () => {
    const supp = await loginShared("supplier", CREDS.supplierPassword);
    const { json } = await call("data", { token: supp });
    const nonSupplier = (json.steps || []).filter((s) => !(s.audience || []).includes("supplier"));
    assert.equal(nonSupplier.length, 0,
      `supplier received ${nonSupplier.length} non-supplier-audience action(s)`);
  });

const bothTierSkip = need({ TEST_RUSHROOM_PASSWORD: CREDS.rushroomPassword, TEST_SUPPLIER_PASSWORD: CREDS.supplierPassword });

test("baseline: the internal (rushroom) view is a superset of the supplier view",
  { skip: bothTierSkip }, async () => {
    const rush = await loginShared("rushroom", CREDS.rushroomPassword);
    const supp = await loginShared("supplier", CREDS.supplierPassword);
    const pick = (j) => (j && j.documents || []).map((d) => d.id);
    const rushDocs = await idsVisible(rush, "data", pick);
    const suppDocs = await idsVisible(supp, "data", pick);
    const suppOnly = [...suppDocs].filter((id) => !rushDocs.has(id));
    assert.equal(suppOnly.length, 0,
      `supplier saw ${suppOnly.length} document(s) the internal view does not`);
  });

/* -------------------- Stage 2+ contract: cross-ORG isolation ------------------ */
// Enable by providing TEST_ORG_A_* and TEST_ORG_B_* once the Organization model
// and session-derived tenant scoping exist. This is the acceptance test the
// whole migration is judged against.

const twoOrgSkip = (CREDS.orgAEmail && CREDS.orgBEmail)
  ? "org model + tenant scoping land in Stage 1–2; enable this test then"
  : "two-org creds not set (and the Organization model is not implemented yet)";

// The tenant-scoped read actions whose results must never overlap across orgs.
const TENANT_READ_PROBES = [
  { action: "data", pick: (j) => (j?.documents || []).map((d) => d.id), label: "documents" },
  { action: "data", pick: (j) => (j?.steps || []).map((s) => s.step), label: "action plan" },
  { action: "standards", pick: (j) => (j?.standards || []).map((s) => s.id), label: "standards" },
  { action: "listProductPassports", pick: (j) => (j?.passports || []).map((p) => p.id), label: "passports" },
  { action: "deviations", pick: (j) => (j?.findings || []).map((f) => f.id), label: "deviation findings" },
];

test("cross-org: no tenant-scoped read leaks between two organizations",
  { skip: twoOrgSkip }, async () => {
    const a = await loginUser(CREDS.orgAEmail, CREDS.orgAPassword);
    const b = await loginUser(CREDS.orgBEmail, CREDS.orgBPassword);
    for (const probe of TENANT_READ_PROBES) {
      const aIds = await idsVisible(a.token, probe.action, probe.pick);
      const bIds = await idsVisible(b.token, probe.action, probe.pick);
      assertNoOverlap(aIds, bIds, `cross-org ${probe.label}`);
    }
  });

test("cross-org: a body-supplied organization_id cannot override the session tenant",
  { skip: twoOrgSkip }, async () => {
    const a = await loginUser(CREDS.orgAEmail, CREDS.orgAPassword);
    const b = await loginUser(CREDS.orgBEmail, CREDS.orgBPassword);
    // Ask as B but forge A's org id in the payload — results must still be B's only.
    const honest = await idsVisible(b.token, "data", (j) => (j?.documents || []).map((d) => d.id));
    const forged = await idsVisible(b.token, "data", (j) => (j?.documents || []).map((d) => d.id),
      { organization_id: a.organization_id });
    assertNoOverlap(await idsVisible(a.token, "data", (j) => (j?.documents || []).map((d) => d.id)), forged,
      "forged org_id must not expose org A to org B");
    assert.deepEqual([...forged].sort(), [...honest].sort(),
      "a forged organization_id changed B's result set — tenancy must be session-derived");
  });
