# portal-api test harness

Dependency-free, black-box tests for the `portal-api` edge function. They talk to
the function over HTTP exactly like the browser does, so they respect the
architecture (browser → edge function → DB) and never touch the database directly.

This is **Stage 0** of the multi-tenant migration: it adds tests only — no runtime
behavior changes — and establishes the **cross-tenant leakage harness** that later
stages switch on.

## Run

```bash
npm test          # → node --test tests/
# or
node --test tests/
```

No install step (no dependencies). Requires Node ≥ 18 (uses `node:test` + global
`fetch`).

## What runs when

| Test group | File | Needs | Behaviour when unset |
|---|---|---|---|
| Smoke (reachability, auth gate, no-body-tenancy) | `smoke.test.mjs` | nothing | always runs |
| Baseline audience isolation (supplier only sees supplier rows) | `cross-tenant.test.mjs` | `TEST_SUPPLIER_PASSWORD` (+ `TEST_RUSHROOM_PASSWORD` for the superset check) | skips |
| **Cross-org isolation** (the migration's acceptance test) | `cross-tenant.test.mjs` | `TEST_ORG_A_*`, `TEST_ORG_B_*` | skips — org model not implemented until Stage 1–2 |

Smoke tests default to the **production** function URL (already public in
`assets/config.js`) and only make unauthenticated, read-only calls (the auth gate
rejects them). Point them elsewhere with `PORTAL_API_URL` to avoid production.

## Environment variables

| Var | Kind | Purpose |
|---|---|---|
| `PORTAL_API_URL` | var | Override the function URL (e.g. a staging deploy). |
| `TEST_RUSHROOM_PASSWORD` | secret | Shared-password rushroom login for baseline tests. |
| `TEST_SUPPLIER_PASSWORD` | secret | Shared-password supplier login for baseline tests. |
| `TEST_ORG_A_EMAIL` / `TEST_ORG_A_PASSWORD` | var / secret | Tenant A account for the cross-org harness. |
| `TEST_ORG_B_EMAIL` / `TEST_ORG_B_PASSWORD` | var / secret | Tenant B account for the cross-org harness. |

CI runs the same command (`.github/workflows/tests.yml`); credentialed tests only
activate when the repo secrets/variables are configured.

## How the harness grows per stage

- **Stage 0 (now):** smoke + baseline audience isolation; cross-org contract
  written but skipped.
- **Stage 1:** add fixtures that create two Organizations and seeded data.
- **Stage 2:** enable the cross-org tests (`TENANT_READ_PROBES` in
  `cross-tenant.test.mjs`) — every tenant-scoped read action must return zero
  overlap between orgs, and a body-supplied `organization_id` must be ignored.
- **Later stages:** extend probes to cover new endpoints (billing, admin,
  impersonation) so each stage lands with its own isolation assertions.

The **`assertNoOverlap`** contract in `helpers.mjs` is deliberately reused
unchanged from audience isolation to org isolation — the boundary changes, the
guarantee does not.
