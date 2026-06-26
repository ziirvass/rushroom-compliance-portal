# Rushroom AB — Compliance Portal

A small, accessible static website that gives all parties — the internal team, component
suppliers, installers and reviewers — one place to see **live compliance readiness** and
reach the **compliance document library** for Rushroom's LED system-furniture product.

Built as plain HTML/CSS/JavaScript (no build step, no framework), so it deploys free on
**GitHub Pages** and can be extended in any editor.

---

## Features

- **Access gate** — a single shared password (light gate; see Security).
- **Readiness view** — reads the 30-step action-plan Google Sheet live and shows overall
  progress, the pre-sale blockers, and every step grouped by phase.
- **Document library** — tidy links to the source files in Google Drive.
- **Supplier view** (`supplier.html`) — a slimmed page for suppliers: only their documents
  and the status of the supplier steps; nothing internal.
- **Accessible** — built to WCAG 2.1 AA (semantic landmarks, keyboard-operable tabs, skip
  link, visible focus, AA contrast, reduced-motion, responsive).

---

## Project structure

```
.
├── index.html            # full portal: readiness dashboard + document library
├── supplier.html         # supplier-only view
├── assets/
│   ├── styles.css        # styling (WCAG 2.1 AA)
│   ├── app.js            # full-portal logic
│   ├── supplier.js       # supplier-view logic
│   └── config.js         # ← edit: password, sheet URL, document links
├── .gitignore
├── CNAME.example         # rename to CNAME for a custom domain
├── .nojekyll             # serve files as-is on GitHub Pages
└── README.md
```

Everything you normally change lives in **`assets/config.js`**.

---

## Setup & deploy (≈10 minutes)

### 1. Set the password
The default password is `Rushroom-Compliance-2026`. Change it: compute the SHA-256 hash of
your new password and paste it into `assets/config.js` → `passwordHash`.

```bash
printf '%s' 'YOUR-NEW-PASSWORD' | shasum -a 256   # macOS
printf '%s' 'YOUR-NEW-PASSWORD' | sha256sum        # Linux
```

(Or, on the live page, open the browser console and run `portalHash('YOUR-NEW-PASSWORD')`.)

### 2. Share the status sheet
The dashboard reads the action-plan sheet live, so set that sheet to
**Anyone with the link → Viewer** in Google Drive. It contains only step statuses (low
sensitivity), not the documents themselves.

### 3. Publish to GitHub Pages
1. Push this folder to a repository (its contents at the repo root, so `index.html` is at
   the top level).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   select `main` / `/ (root)`, and save.
3. The site goes live at `https://<your-username>.github.io/<repo-name>/` within a minute.

### 4. (Optional) Custom domain
Rename `CNAME.example` to `CNAME`, put your domain inside (e.g. `compliance.rushroom.se`),
add the same domain under Settings → Pages, and create a CNAME DNS record at your provider.

---

## Updating

- **Status** — edit the action-plan Google Sheet; the dashboard reads it live (press
  *Reload status*). No redeploy needed.
- **Documents / password** — edit `assets/config.js` and commit the change.

---

## Security

This is a **static** site, so the shared password lives in the browser — it keeps casual
visitors out but is **not** strong security. Real protection of each document comes from
**Google Drive sharing**: a person can only open a linked file if Drive permits it.

- Keep sensitive files (test reports, signed Declaration of Conformity, supplier
  declarations) shared only with the right people in Drive.
- A **public** GitHub repo exposes `config.js` (the password hash and document links).
  The links stay protected by Drive permissions; if you need the code private too, that
  requires a paid GitHub plan.

---

## Accessibility

Conforms to **WCAG 2.1 AA** at the code level: semantic `header`/`main`/`footer`
landmarks, a skip link, keyboard-operable tabs (arrow-key navigation), a labelled password
field with live error messaging, visible focus outlines, AA colour contrast (lowest pair
4.56:1), responsive layout, and reduced-motion support. A screen-reader pass and a
Lighthouse/axe run on the deployed URL are recommended before go-live.

---

## Tech

Vanilla HTML, CSS and JavaScript. No dependencies, no build tooling. Data is read from a
published Google Sheet (CSV) at runtime; documents are hosted in Google Drive.

## Roadmap (optional, for later)

- Per-role logins (suppliers vs authorities vs internal) — requires a small backend or an
  auth service; GitHub Pages alone cannot do real logins.
- Search/filtering across documents and steps.
- A supplier declaration upload form.

---

_Internal compliance tool for Rushroom AB. Not legal advice._
