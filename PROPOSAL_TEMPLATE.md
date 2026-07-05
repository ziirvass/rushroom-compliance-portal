# Proposal Template — How to Add New Proposals

Use this template to propose new features or improvements. Copy this and fill in the fields, then add to PROPOSALS.json.

---

## Proposal Structure

```json
{
  "id": "PROP-XXX",
  "date_proposed": "YYYY-MM-DD",
  "title": "Brief descriptive title (max 80 chars)",
  "status": "draft",
  "category": "UI|Feature|Workflow|Analytics|AI Feature|Localization|Automation|Compliance",
  "description": "1-2 sentence description of what this is",
  "cause": [
    "First problem this solves",
    "Second problem",
    "Third problem - why do we need this?"
  ],
  "effect": [
    "First change that would be made",
    "Second change",
    "Third change - what does the user see/experience?"
  ],
  "implications": [
    "Effort: X-Y hours",
    "Risk: Low/Medium/High (explain briefly)",
    "Dependencies: Other features or systems required",
    "Browser compatibility: Modern browsers / IE 11 / etc.",
    "Performance: Impact on load times, DB queries, etc.",
    "Data volume: Does it increase storage?",
    "User training: Do users need new documentation?",
    "Operational: What must DevOps/support know about?"
  ],
  "proposed_by": "GitHub Copilot or [Your Name]",
  "priority": "HIGH|MEDIUM|LOW",
  "estimated_effort_hours": 3,
  "implementation_checklist": [
    "Task 1 to complete",
    "Task 2 to complete",
    "Task 3 to complete"
  ],
  "implementation_notes": "Notes about MVP, dependencies, nice-to-haves, or deferrable aspects",
  "commits_implemented": [],
  "percentage_complete": 0
}
```

---

## Field Definitions

### `id` (required)
- Format: `PROP-XXX` (e.g., `PROP-011`)
- Must be unique
- Sequential numbering

### `date_proposed` (required)
- Date in ISO 8601 format (YYYY-MM-DD)
- When was this idea created?

### `title` (required)
- Concise, descriptive (max 80 characters)
- Should be clear enough to understand at a glance
- Example: "Bulk Interpretation Generation & Approval Workflow"

### `status` (required)
One of: `draft`, `proposed`, `in_progress`, `implemented`, `rejected`

- **draft:** Idea, not yet formally reviewed
- **proposed:** Reviewed and approved for consideration
- **in_progress:** Currently being developed
- **implemented:** Complete and deployed
- **rejected:** Decided not to implement (keep for historical record)

### `category` (required)
One of: `UI`, `Feature`, `Workflow`, `Analytics`, `AI Feature`, `Localization`, `Automation`, `Compliance`

Helps organize proposals by type.

### `description` (required)
1-2 sentences explaining what this proposal is about.

**Good example:** "Automatically trigger compliance matrix recalculation whenever an interpretation is saved, providing real-time view of compliance changes."

### `cause` (required, array)
List of problems this proposal solves. Each bullet should explain:
- What's the pain point?
- Why do we need this?
- What gap does it fill?

**Example:**
```json
"cause": [
  "Users need to see compliance impact immediately after saving interpretations",
  "Currently requires manual refresh or page reload",
  "Could detect patterns (e.g., multiple deviations in same clause across docs)"
]
```

### `effect` (required, array)
List of changes that would be made. What does the system look like after this is implemented?

**Example:**
```json
"effect": [
  "Add background task to portal-api that triggers on saveInterpretation() completion",
  "Emit WebSocket or server-sent events to connected clients",
  "Update compliance matrix UI in real-time without page reload"
]
```

### `implications` (required, array)
List of considerations: effort, risk, dependencies, performance, etc.

**Key things to address:**
- **Effort:** Time estimate (hours or days)
- **Risk:** Low/Medium/High and why
- **Dependencies:** What else must be in place first?
- **Browser compatibility:** Does it work in all browsers? (IE 11? Safari?)
- **Performance:** Any load/speed concerns?
- **Data volume:** Does it increase storage, queries, network load?
- **User training:** Do users need documentation/training?
- **Operational:** What does DevOps/support need to know?
- **UX impact:** Positive, neutral, or negative for users?

**Example:**
```json
"implications": [
  "Effort: ~2-3 hours (backend + frontend)",
  "Risk: Medium (adds real-time complexity, WebSocket dependencies)",
  "Dependencies: WebSocket support or Server-Sent Events",
  "Browser compatibility: Modern browsers only (IE 11 may not support)",
  "Performance: Could impact server if many users editing simultaneously",
  "UX benefit: Highly visible - users see changes immediately",
  "Operational: May need monitoring for WebSocket connection issues"
]
```

### `proposed_by` (required)
Who came up with this idea? Name or system.

### `priority` (required)
One of: `HIGH`, `MEDIUM`, `LOW`

- **HIGH:** Critical for business, regulatory requirement, or core feature
- **MEDIUM:** Nice-to-have, improves workflow, adds value
- **LOW:** Enhancement, nice-to-have, low impact if deferred

**Examples:**
- Phase 5 Frontend UI: HIGH (needed for core functionality)
- Real-time Matrix Updates: MEDIUM (nice-to-have, not blocking)
- Multi-language Support: LOW (no user demand yet)

### `estimated_effort_hours` (required)
Number of hours estimated to complete this proposal.

**Guideline:**
- 1-2 hours: Trivial (small UI change, simple API action)
- 2-4 hours: Small (one feature, no dependencies)
- 4-8 hours: Medium (several components, some complexity)
- 8+ hours: Large (significant refactor, many dependencies)

**Be realistic.** Most features take longer than expected.

### `implementation_checklist` (required)
List of concrete tasks that must be completed to fulfill this proposal.

Make these actionable and checkable.

**Example:**
```json
"implementation_checklist": [
  "Create renderStandardDetails() function in app.js",
  "Add 'Extract clauses' button to Standards tab",
  "Fetch clauses from getClausesForStandard API",
  "Render clauses as sortable table",
  "Add filtering by clause type/status"
]
```

### `implementation_notes` (required)
Free-form notes about:
- MVP (Minimum Viable Product) vs. full implementation
- Dependencies on other proposals
- Deferrable aspects
- Gotchas or tricky parts
- Recommendations

**Example:**
```json
"implementation_notes": "Depends on PROP-001 (Compliance Matrix must exist first). Consider MVP: generate all clauses, review inline (no staged workflow). Staged approval can be Phase 5b enhancement."
```

### `commits_implemented` (required, array)
List of git commit hashes that implemented this proposal.

Empty until implementation starts. Filled in during/after development.

**Example:**
```json
"commits_implemented": [
  "abc1234 feat: add renderStandardDetails() function",
  "def5678 refactor: update API response format",
  "ghi9012 test: add compliance matrix tests"
]
```

### `percentage_complete` (required, number)
0-100, updated as development progresses.

- 0%: Not started
- 25%: Research/design phase
- 50%: Core implementation
- 75%: Testing/refinement
- 100%: Complete and deployed

---

## How to Add a New Proposal

### Step 1: Brainstorm
Identify the problem or feature idea.

### Step 2: Fill in Cause/Effect
- **Cause:** What problems does this solve?
- **Effect:** What changes would happen?

### Step 3: Think Through Implications
- Time estimate?
- Dependencies on other features?
- Risk? Performance? UX?
- Browser compatibility?
- Data/storage impact?

### Step 4: Create Checklist
Break down implementation into 3-5 concrete tasks.

### Step 5: Add to PROPOSALS.json
Copy template, fill in all fields, append to JSON array.

**Check:**
- ✅ Unique ID
- ✅ All required fields filled
- ✅ Status is "draft"
- ✅ Valid category
- ✅ Valid priority
- ✅ JSON is valid (no syntax errors)

### Step 6: Update SYSTEM_OVERVIEW.html
If HIGH or MEDIUM priority, add a proposal card to Section 12.

### Step 7: Commit
```bash
git add PROPOSALS.json SYSTEM_OVERVIEW.html
git commit -m "docs: add PROP-XXX: [Brief Title]"
git push origin main
```

---

## Decision Flowchart

When reviewing a proposal:

```
Does it solve a real problem?
  ├─ NO → Reject (mark status: rejected)
  └─ YES ↓
  
Do we have capacity to do it?
  ├─ NO → Defer (mark status: proposed)
  └─ YES ↓
  
Is it aligned with business goals?
  ├─ NO → Reject
  └─ YES ↓
  
What's the priority?
  ├─ HIGH → Start immediately (status: in_progress)
  ├─ MEDIUM → Schedule for next phase (status: proposed)
  └─ LOW → Add to backlog (status: draft)
```

---

## Examples

### Small, Low-Risk Proposal
```json
{
  "id": "PROP-006",
  "title": "AI-Suggested Compliance Status",
  "status": "draft",
  "priority": "LOW",
  "estimated_effort_hours": 2,
  "cause": [
    "Users manually set status for each interpretation",
    "Claude already read document - could provide preliminary assessment"
  ],
  "effect": [
    "Claude suggests status (compliant/deviation/pending/na) during generation",
    "UI shows suggested_status as pre-filled but editable"
  ],
  "implications": [
    "Effort: 2 hours (minimal)",
    "Risk: Low (suggestion only, user decides)",
    "Token usage: Minimal",
    "UX: Moderate improvement"
  ]
}
```

### Large, High-Value Proposal
```json
{
  "id": "PROP-010",
  "title": "ESPR Compliance Path Tracing",
  "status": "proposed",
  "priority": "HIGH",
  "estimated_effort_hours": 8,
  "cause": [
    "EU regulators will ask 'How did you ensure compliance with Article 8?'",
    "Need complete chain from regulation to implementation to declaration",
    "Current system has pieces but no integrated visualization"
  ],
  "effect": [
    "New 'Compliance Paths' view in portal",
    "Shows: Clause → Implementation → Interpretation → Product → DPP",
    "Generates compliance chain PDF for auditors"
  ],
  "implications": [
    "Effort: 8 hours",
    "Risk: Medium (regulatory compliance - must be accurate)",
    "Regulatory value: Very high",
    "ESPR deadline: 2027"
  ]
}
```

---

## Review Checklist

Before adding a proposal to PROPOSALS.json:

- [ ] Is the ID unique?
- [ ] Are all required fields present?
- [ ] Is the `status` one of: draft, proposed, in_progress, implemented, rejected?
- [ ] Is the `priority` one of: HIGH, MEDIUM, LOW?
- [ ] Is the `category` appropriate?
- [ ] Does `cause` clearly explain the problem?
- [ ] Does `effect` describe what users would see?
- [ ] Are `implications` thoughtful and realistic?
- [ ] Is `estimated_effort_hours` reasonable?
- [ ] Is the `implementation_checklist` actionable?
- [ ] Is the `description` clear enough to understand the idea immediately?
- [ ] Is JSON valid (no syntax errors)?

---

**Last Updated:** 2026-07-05  
**Template Version:** 1.0
