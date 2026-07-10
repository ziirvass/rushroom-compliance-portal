# Deployment Checklist & Handoff Guide

**Prepared for Claude Code transition**

> ### ⚠️ Superseded (2026-07-04, Claude Code)
> This checklist framed the Phase 5 UI as the remaining work and the backend as "ready to use." In reality the backend was undeployed and buggy (full correction in `README_HANDOFF.md`). It has since been **fixed, deployed, and the Phase 5 UI built and verified live**. The "what's left" below is now **done**. Process fix: `supabase db push` does **not** apply the schema here (no `migrations/` dir) — use the **SQL Editor**.

---

## ✅ What's Done (2026-07-04)

### Database & Backend
- [x] Schema applied via the Supabase **SQL Editor** (4 tables, RLS, indexes) — *not* `db push`
- [x] Edge function **fixed** (compile/auth/order bugs) and deployed; interpretations rewritten for PDFs + batching
- [x] **Passport CRUD** actions added (were missing) + api.js wrappers
- [x] All changes committed to `main`

### Frontend UI — ✅ built + tested + live
- [x] "Clauses & DPP" tab with 4 sub-views (Clauses, Interpretations, Matrix, Passports)
- [x] 15/15 mock tests + full live end-to-end run passed

### Not done
- [ ] **Phase 3** structured deviation scan (`runDeviationScan` still always uses AI)

### Verification Commands
```bash
supabase functions list        # confirm portal-api deployed
# Test API from the browser console (authenticated Rushroom session):
await PortalAPI.getClausesForStandard(token, "standard-version-uuid")
```

---

## Reference: the original Phase 5 UI plan (now implemented as described)

---

## Implementation Priorities

### Priority 1: Extract & View Clauses (Foundation)
1. Add button "Extract clauses" in Standards tab (when standard version selected)
2. Calls `PortalAPI.extractStandardClauses(token, { standardVersionId })`
3. Add "View clauses" section showing results as table
   - Columns: Clause Ref | Title | Type | Full Text
   - Sortable by ref or type
4. **Estimated time:** 1-1.5 hours

### Priority 2: Generate & Save Interpretations (Core)
1. Add "Generate interpretations" button in Documents tab
   - Lists extracted clauses for each standard
   - Calls `PortalAPI.generateInterpretations(token, { documentVersionId, clauseIds })`
2. Show progress while Claude generates proposals
3. Add interpretation editor form (modal or inline)
   - Read-only clause info
   - Editable: interpretation_text, compliance_status, rationale, deviation_description
   - Save button → `PortalAPI.saveInterpretation(token, id, fields)`
   - Show reviewed_by, reviewed_at (audit trail)
4. **Estimated time:** 2-2.5 hours

### Priority 3: Compliance Matrix (Visualization)
1. New tab or section: "Compliance Matrix"
2. Dropdown/checkboxes to select documents and standards
3. Call `PortalAPI.complianceMatrix(token, { documentVersionIds, standardVersionIds })`
4. Render as grid (HTML table or canvas):
   - Rows = document versions
   - Columns = standard clauses (grouped by standard)
   - Cells color-coded: green/amber/grey/white
   - Click cell to open interpretation editor
5. **Estimated time:** 1-1.5 hours

### Priority 4: Passport Management (Optional First Release)
1. New tab: "Digital Passports"
2. List all `product_passports` records
3. "Create passport" form (product_name, gtin, manufacturer)
4. "Link interpretations" modal to select which interpretations apply
5. "Export DPP JSON-LD" button → `PortalAPI.exportProductPassport(token, { passportId, format: 'json-ld' })`
6. **Estimated time:** 1.5-2 hours (can defer to Phase 5b)

---

## Code Structure Reference

### Existing UI Pattern (for consistency)

From `assets/app.js`, tabs are rendered via functions like:
```javascript
async function renderDocuments() {
  // Fetch data
  const docs = await PortalAPI.listDocuments(token);
  
  // Build HTML
  const html = `<div>...${docs.map(d => `<div>${d.name}</div>`).join('')}...</div>`;
  
  // Insert into DOM
  document.getElementById('documents-content').innerHTML = html;
  
  // Attach event handlers
  document.querySelectorAll('.doc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      // Handle click
    });
  });
}
```

Follow this pattern for Level 2 functions:
- `renderStandardDetails(standardVersion)`
- `renderInterpretationEditor(interpretation, clause)`
- `renderComplianceMatrix(selectedDocs, selectedStandards)`
- `renderPassportView()`

### HTML Tab Navigation

Tabs are defined in `index.html` with IDs like:
- `#documents-tab` → renders with `renderDocuments()`
- `#standards-tab` → renders with `renderStandards()`
- Add optional: `#compliance-tab` or `#passports-tab`

Each tab button fires:
```javascript
document.getElementById('compliance-tab').addEventListener('click', renderComplianceMatrix);
```

---

## Testing Strategy

### Unit Test (API Actions)
```javascript
// In browser console after deploying
token = "your-rushroom-token";

// Test 1: Extract clauses
result = await PortalAPI.extractStandardClauses(token, {
  standardVersionId: "paste-actual-uuid-from-db"
});
console.log("Extract result:", result);

// Test 2: Get clauses
clauses = await PortalAPI.getClausesForStandard(token, "same-uuid");
console.log("Clauses:", clauses);

// Test 3: Generate interpretations
result = await PortalAPI.generateInterpretations(token, {
  documentVersionId: "paste-doc-uuid",
  clauseIds: clauses.clauses.map(c => c.id).slice(0, 5) // first 5 for testing
});
console.log("Generation result:", result);

// Test 4: View interpretations
interps = await PortalAPI.getInterpretations(token, "doc-uuid");
console.log("Interpretations:", interps);

// Test 5: Compliance matrix
matrix = await PortalAPI.complianceMatrix(token, {
  documentVersionIds: ["doc-uuid"],
  standardVersionIds: ["std-uuid"]
});
console.log("Matrix:", matrix);

// Test 6: Export DPP
dpp = await PortalAPI.exportProductPassport(token, {
  passportId: "passport-uuid",
  format: "json-ld"
});
console.log("DPP:", JSON.stringify(dpp, null, 2));
```

### Integration Test (UI)
1. Open portal in browser
2. Go to Standards tab → click a standard → "Extract clauses" button
3. Verify clauses appear in table below
4. Go to Documents tab → click an As Operates doc → "Generate interpretations" button
5. Verify interpretations load and can be edited/saved
6. Go to Compliance tab (if added) → select doc + standards → verify grid renders
7. Go to Passports tab (if added) → create new → export JSON-LD

---

## Git Workflow for Phase 5

```bash
# Start Phase 5 branch
git checkout -b feature/phase5-ui

# Make incremental commits as each UI function is added
git add assets/app.js
git commit -m "feat: add renderStandardDetails() function"

git add assets/app.js
git commit -m "feat: add renderInterpretationEditor() function"

# After testing, merge back to main
git checkout main
git merge feature/phase5-ui
git push origin main
```

---

## Troubleshooting Common Issues

### Issue: "Unknown action" error when calling API
**Cause:** Edge function not deployed or action name mismatch  
**Fix:** 
```bash
supabase functions deploy portal-api --no-verify-jwt
```

### Issue: Claude API errors (timeout, no response)
**Cause:** Large document or slow response  
**Fix:** 
- Check ANTHROPIC_API_KEY is set in Supabase secrets
- Test with smaller document first
- Increase timeout in edge function if needed (currently ~30s)

### Issue: Interpretation saves but doesn't appear in UI
**Cause:** UI not refreshing after save  
**Fix:** After `saveInterpretation()` returns OK, call `renderInterpretationEditor()` again to refresh

### Issue: RLS error "new row violates row-level security"
**Cause:** Trying to insert via client instead of service-role  
**Fix:** All inserts MUST go through edge function; never query database directly from browser

### Issue: "Clause ID not found"
**Cause:** `generateInterpretations` called with wrong `clauseIds`  
**Fix:** Verify clauses exist: `await PortalAPI.getClausesForStandard(token, standardVersionId)`

---

## Performance Notes

- **Extract clauses:** ~10s per 100-page PDF (Claude processing)
- **Generate interpretations:** ~5s per clause (Claude processing)
- **Get interpretations:** <100ms (database query)
- **Compliance matrix:** <500ms for 10 docs × 100 clauses

For large batch operations, consider:
- Progressive UI updates (show as clauses/interpretations load)
- Background processing indication (spinner, progress bar)
- Batch size limits (e.g., max 50 clauses per generation)

---

## Security Checklist

- [x] All new tables have RLS enabled with deny-all default
- [x] Service-role key used for server-side queries
- [x] No client-side direct database access
- [x] Rushroom-only authorization checks on all new actions
- [x] Claude API key stored in Supabase secrets (not in code)
- [ ] Add rate limiting for AI actions (if needed)
- [ ] Audit log: Track who approved deviations (already in schema: `deviation_accepted_by`, `reviewed_by`)

---

## Documentation to Create (Optional but Recommended)

1. **User Guide — Level 2 Features**
   - How to extract clauses from a standard
   - How to generate interpretations
   - How to use the compliance matrix
   - How to export a DPP

2. **Administrator Guide**
   - Database maintenance (backup, cleanup old versions)
   - Claude API quota management
   - User role management

3. **Developer Guide**
   - How to add new AI actions
   - How to modify the compliance matrix query logic
   - How to extend the DPP export format

---

## Rollback Steps (If Needed)

If Phase 5 UI breaks existing functionality:

```bash
# Revert to last working commit
git log --oneline | head -5  # Find commit hash
git checkout <hash> -- assets/app.js

# Or revert entire Phase 5 branch
git reset --hard HEAD~N  # Where N is number of commits to undo
```

All code is version-controlled; nothing is permanent.

---

## Final Verification Checklist

Before marking "ready for production":

**Backend:**
- [x] Schema applied via **SQL Editor** (not `db push` — no migrations dir)
- [ ] `supabase functions deploy portal-api` completed without errors
- [ ] All 4 new tables visible in Supabase dashboard
- [ ] All 7 new actions return valid JSON responses

**API:**
- [ ] `PortalAPI.extractStandardClauses()` works
- [ ] `PortalAPI.generateInterpretations()` works
- [ ] `PortalAPI.saveInterpretation()` works
- [ ] `PortalAPI.getInterpretations()` works
- [ ] `PortalAPI.complianceMatrix()` works
- [ ] `PortalAPI.exportProductPassport()` returns valid JSON-LD

**UI:**
- [ ] Standards detail view renders clauses as table
- [ ] Interpretation editor form displays and saves
- [ ] Compliance matrix renders as grid with color-coded cells
- [ ] Passport view creates/exports passports
- [ ] All new features use correct token/authorization

**Regression:**
- [ ] Existing Level 1 features still work (documents, standards, drafts, deviation scans)
- [ ] No console errors
- [ ] RLS policies working (direct queries fail, API succeeds)

---

## Quick Commands Reference

```bash
# Deploy
# schema: paste supabase/schema.sql into the Supabase SQL Editor (no `db push` here)
supabase functions deploy portal-api --no-verify-jwt

# View logs
supabase functions list
supabase functions list --output table

# Check schema
supabase db tables list

# Local testing (if using local Supabase)
supabase start
supabase functions serve

# Stop local
supabase stop

# Push changes to main
git add .
git commit -m "Phase 5: Add Level 2 UI functions"
git push origin main
```

---

**Status: Ready for Claude Code  ✅**  
**Next session: Implement Phase 5 UI (~4 hours)**
