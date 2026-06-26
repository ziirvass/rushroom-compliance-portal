/*
 * Rushroom AB — Compliance Portal configuration
 * ============================================================================
 * This is the only file you normally edit. See README.md for full instructions.
 *
 * SAFE TO COMMIT, but remember: a public repo exposes everything below.
 * Real protection of each document comes from Google Drive sharing, not this file.
 */
window.PORTAL_CONFIG = {
  org: "Rushroom AB",
  product: "LED system-furniture",

  /* ---- Access gate -------------------------------------------------------
   * SHA-256 hex hash of the shared password (NOT the password itself).
   * Default below corresponds to:  Rushroom-Compliance-2026
   * To change: run  printf '%s' 'NEW-PASSWORD' | shasum -a 256
   * or in the browser console on the live site:  portalHash('NEW-PASSWORD')
   */
  passwordHash: "b0eb72b1c6231cbc7bc759a84148de428650f650878f2fdd7c6ecbacdaf1dd4f",

  /* ---- Live status source ------------------------------------------------
   * Published CSV URL of the 30-step action-plan Google Sheet.
   * In the Sheet:  File → Share → Publish to web → (whole sheet) → CSV → Publish,
   * then paste the generated link here. Leave "" to use the bundled sample below.
   *
   * Expected columns (header row, any order):
   *   step, phase, action, status, owner, presale, audience, doc, notes
   *   - status:   Done | In progress | Not started | Blocked
   *   - presale:  TRUE/FALSE (is this a pre-sale blocker?)
   *   - audience: comma-separated, e.g. "internal, supplier"
   *   - doc:      optional Google Drive link for that step
   */
  statusSheetCsvUrl: "",

  /* ---- Document library --------------------------------------------------
   * Links to the source files in Google Drive. `audience` controls who sees a
   * document: include "supplier" to surface it on supplier.html.
   */
  documents: [
    { category: "Declarations", name: "EU Declaration of Conformity (DoC)", url: "", audience: ["internal", "reviewer"] },
    { category: "Declarations", name: "CE marking artwork & label", url: "", audience: ["internal", "supplier"] },
    { category: "Test reports", name: "LVD / electrical safety report (EN 60598)", url: "", audience: ["internal", "reviewer"] },
    { category: "Test reports", name: "EMC test report (EN 55015 / EN 61547)", url: "", audience: ["internal", "reviewer"] },
    { category: "Technical file", name: "Technical construction file", url: "", audience: ["internal", "reviewer"] },
    { category: "Technical file", name: "Risk assessment", url: "", audience: ["internal"] },
    { category: "Materials", name: "RoHS / REACH declarations", url: "", audience: ["internal", "supplier", "reviewer"] },
    { category: "Supplier", name: "Supplier declaration template", url: "", audience: ["internal", "supplier"] },
    { category: "Supplier", name: "Component datasheets (LED drivers, modules)", url: "", audience: ["internal", "supplier"] },
    { category: "Installation", name: "Installation & safety manual", url: "", audience: ["internal", "installer"] },
  ],

  /* ---- Bundled sample status --------------------------------------------
   * Used only when statusSheetCsvUrl is empty, so the dashboard is never blank.
   * Mirrors the Sheet schema above. Replace by connecting the live Sheet.
   */
  sampleSteps: [
    { step: 1, phase: "1 · Scope & standards", action: "Confirm product classification & applicable directives (LVD, EMC, RoHS)", status: "Done", owner: "Mathias", presale: "TRUE", audience: "internal" },
    { step: 2, phase: "1 · Scope & standards", action: "Identify harmonised standards (EN 60598, EN 55015, EN 62471)", status: "Done", owner: "Mathias", presale: "TRUE", audience: "internal" },
    { step: 3, phase: "1 · Scope & standards", action: "Define product variants & model numbering", status: "Done", owner: "Mathias", presale: "FALSE", audience: "internal" },
    { step: 4, phase: "1 · Scope & standards", action: "Compile bill of materials with component sources", status: "In progress", owner: "Procurement", presale: "FALSE", audience: "internal, supplier" },
    { step: 5, phase: "2 · Electrical safety (LVD)", action: "Select certified LED driver (CE + safety marks)", status: "Done", owner: "Engineering", presale: "TRUE", audience: "internal, supplier" },
    { step: 6, phase: "2 · Electrical safety (LVD)", action: "Insulation & creepage/clearance review", status: "In progress", owner: "Engineering", presale: "TRUE", audience: "internal" },
    { step: 7, phase: "2 · Electrical safety (LVD)", action: "Book accredited LVD test (EN 60598-1)", status: "Not started", owner: "Engineering", presale: "TRUE", audience: "internal" },
    { step: 8, phase: "2 · Electrical safety (LVD)", action: "Temperature rise / thermal test", status: "Not started", owner: "Lab", presale: "FALSE", audience: "internal" },
    { step: 9, phase: "2 · Electrical safety (LVD)", action: "Photobiological safety assessment (EN 62471)", status: "Not started", owner: "Lab", presale: "FALSE", audience: "internal" },
    { step: 10, phase: "3 · EMC", action: "Pre-compliance EMC scan", status: "In progress", owner: "Engineering", presale: "FALSE", audience: "internal" },
    { step: 11, phase: "3 · EMC", action: "Radiated & conducted emissions test (EN 55015)", status: "Not started", owner: "Lab", presale: "TRUE", audience: "internal" },
    { step: 12, phase: "3 · EMC", action: "Immunity test (EN 61547)", status: "Not started", owner: "Lab", presale: "TRUE", audience: "internal" },
    { step: 13, phase: "3 · EMC", action: "Harmonic current emissions (EN 61000-3-2)", status: "Not started", owner: "Lab", presale: "FALSE", audience: "internal" },
    { step: 14, phase: "4 · Materials & environment", action: "Collect RoHS declarations from all suppliers", status: "In progress", owner: "Procurement", presale: "TRUE", audience: "internal, supplier" },
    { step: 15, phase: "4 · Materials & environment", action: "REACH SVHC screening", status: "Not started", owner: "Procurement", presale: "FALSE", audience: "internal, supplier" },
    { step: 16, phase: "4 · Materials & environment", action: "WEEE producer registration", status: "Not started", owner: "Mathias", presale: "FALSE", audience: "internal" },
    { step: 17, phase: "4 · Materials & environment", action: "Packaging compliance (PPWD)", status: "Not started", owner: "Operations", presale: "FALSE", audience: "internal" },
    { step: 18, phase: "5 · Documentation", action: "Assemble technical construction file", status: "In progress", owner: "Mathias", presale: "TRUE", audience: "internal, reviewer" },
    { step: 19, phase: "5 · Documentation", action: "Complete risk assessment", status: "Not started", owner: "Engineering", presale: "FALSE", audience: "internal" },
    { step: 20, phase: "5 · Documentation", action: "Write installation & safety manual", status: "Not started", owner: "Operations", presale: "FALSE", audience: "internal, installer" },
    { step: 21, phase: "5 · Documentation", action: "Prepare user instructions & warnings", status: "Not started", owner: "Operations", presale: "FALSE", audience: "internal, installer" },
    { step: 22, phase: "5 · Documentation", action: "Draft EU Declaration of Conformity", status: "Not started", owner: "Mathias", presale: "TRUE", audience: "internal, reviewer" },
    { step: 23, phase: "5 · Documentation", action: "Design CE mark & rating label", status: "Not started", owner: "Design", presale: "TRUE", audience: "internal, supplier" },
    { step: 24, phase: "6 · Suppliers & production", action: "Sign supplier compliance declarations", status: "Blocked", owner: "Procurement", presale: "TRUE", audience: "internal, supplier" },
    { step: 25, phase: "6 · Suppliers & production", action: "Incoming inspection plan for components", status: "Not started", owner: "Quality", presale: "FALSE", audience: "internal, supplier" },
    { step: 26, phase: "6 · Suppliers & production", action: "Production control / consistency procedure", status: "Not started", owner: "Quality", presale: "FALSE", audience: "internal" },
    { step: 27, phase: "6 · Suppliers & production", action: "First-article inspection & sign-off", status: "Not started", owner: "Quality", presale: "FALSE", audience: "internal, supplier" },
    { step: 28, phase: "6 · Suppliers & production", action: "Affix CE mark to production units", status: "Not started", owner: "Production", presale: "TRUE", audience: "internal" },
    { step: 29, phase: "6 · Suppliers & production", action: "Archive technical file (10-year retention)", status: "Not started", owner: "Mathias", presale: "FALSE", audience: "internal" },
    { step: 30, phase: "6 · Suppliers & production", action: "Final compliance review & go-live sign-off", status: "Not started", owner: "Mathias", presale: "TRUE", audience: "internal, reviewer" },
  ],
};
