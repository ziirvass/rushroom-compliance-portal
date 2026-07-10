# /ideate — Capture and structure a new feature idea

The idea to explore is: $ARGUMENTS

## Step 1 — Read what already exists
Read docs/IDEAS.md to see existing ideas.
Read docs/SYSTEM_OVERVIEW.html sections 2 (tables) and 14 (proposals).
Check: does a PROP already cover this idea?

## Step 2 — Think it through
Answer these questions before writing anything:
- What real problem does this solve?
- What already exists that could be extended?
- Which tables and API actions would this touch?
- What is the smallest version that proves the value?
- What could go wrong?
- How does this interact with PROP-012 multi-tenancy?

## Step 3 — Write to IDEAS.md
Append this block to docs/IDEAS.md:

---
### [idea title] — [today's date]
**One sentence:** [what it does]
**Problem it solves:** [the pain]
**MVP scope:** [smallest thing worth building]
**Tables involved:** [list]
**Effort estimate:** [X hours]
**Risks:** [what could go wrong]
**Related PROPs:** [any overlap with existing proposals]
**Status:** Raw idea

## Step 4 — Confirm
Tell me: "Written to IDEAS.md. Run /build '[idea title]' to generate the implementation spec."