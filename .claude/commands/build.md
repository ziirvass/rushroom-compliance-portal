# /build — Generate a full implementation spec for a feature

The feature to spec out: $ARGUMENTS

## Step 1 — Find the idea
Read docs/IDEAS.md and find the entry matching the feature name above.
If nothing matches, treat $ARGUMENTS as the idea description directly.

## Step 2 — Read system context
Read docs/SYSTEM_OVERVIEW.html:
- Section 2: current table inventory
- Section 9: existing API actions
- Section 14: current proposals (find the PROP number if it exists)

## Step 3 — Generate the spec
Output a complete implementation plan with these sections:

### Feature: [name]
**PROP number:** PROP-0XX (next available number)
**Effort estimate:** X hours
**Risk:** Low / Medium / High

### What to build
[Clear description of what changes and what stays the same]

### New DB migration
File: supabase/migrations/00XX_[feature_name].sql
[Show the complete SQL — CREATE TABLE with organization_id NOT NULL, RLS policies]

### New API actions in portal-api/index.ts
[For each action: name, input params, output, what it does in plain English]

### Frontend changes in assets/app.js
[Which functions to add or modify, which tab they appear in]

### Architecture checklist
- [ ] Every new table has organization_id UUID NOT NULL?
- [ ] RLS deny-all policy on every new table?
- [ ] New action dispatched via body.action in index.ts?
- [ ] Using haiku (not opus) for cheap AI calls?

### How to test
[Step-by-step: what to click, what to expect, what proves it works]

### SYSTEM_OVERVIEW sections to update
[Which sections change — /ship will handle the actual update]

## Step 4 — Ask for confirmation
After showing the spec, ask: "Does this look right? Say 'go ahead' to start building,
or tell me what to change."