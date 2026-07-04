/* Rushroom AB — Compliance Portal
 * Shared logic (window.Portal) + full-portal page init.
 * No framework, no build step. Accessibility: see README "Accessibility".
 */
(() => {
  "use strict";
  const CFG = window.PORTAL_CONFIG || {};
  const AUTH_KEY = "rushroom_portal_auth";

  /* ---------------- DOM helpers ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return n;
  }

  // Turn literal \uXXXX escapes (sometimes emitted in AI drafts) into real chars.
  const unescapeUnicode = (s) => (s || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)));

  const _scriptCache = {};
  function loadScript(src) {
    if (!_scriptCache[src]) _scriptCache[src] = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src;
      s.onload = res; s.onerror = () => { delete _scriptCache[src]; rej(new Error("Couldn't load a helper library (offline?)")); };
      document.head.appendChild(s);
    });
    return _scriptCache[src];
  }
  const MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js";

  /* ---------------- password gate ---------------- */
  async function portalHash(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  window.portalHash = portalHash; // exposed for console use (see README)

  function setupGate(onUnlock) {
    const gate = $("#gate"), appEl = $("#portal-app");
    const reveal = () => {
      gate.hidden = true;
      appEl.hidden = false;
      onUnlock();
    };
    if (sessionStorage.getItem(AUTH_KEY) === "1") { reveal(); return; }

    const form = $("#gate-form"), input = $("#portal-password"), err = $("#gate-error");
    input.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      input.setAttribute("aria-invalid", "false");
      let ok = false;
      try { ok = (await portalHash(input.value)) === CFG.passwordHash; } catch { ok = false; }
      if (ok) {
        sessionStorage.setItem(AUTH_KEY, "1");
        reveal();
        const h = appEl.querySelector("h2, h3");
        if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
      } else {
        input.setAttribute("aria-invalid", "true");
        err.textContent = "Incorrect password. Please try again.";
        input.select();
      }
    });
  }

  /* ---------------- CSV ---------------- */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, q = false;
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const header = rows.shift().map((h) => h.trim().toLowerCase());
    return rows
      .filter((r) => r.some((v) => v.trim() !== ""))
      .map((r) => Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? "").trim()])));
  }

  /* ---------------- status model ----------------
   * The action-plan sheet uses free-text status ("Done (documented)", "Open",
   * "Active"), so classification is fuzzy rather than an exact lookup. */
  const norm = (s) => (s || "").trim().toLowerCase();
  const isDone = (s) => /\bdone\b|complete|closed|signed/.test(norm(s));
  function statusInfo(raw) {
    const s = norm(raw);
    let cls = "s-todo";
    if (isDone(s)) cls = "s-done";
    else if (/progress|active|wip|started/.test(s)) cls = "s-progress";
    else if (/block(?!er)|on hold|stuck/.test(s)) cls = "s-blocked";
    return { label: (raw || "").trim() || "Open", cls, done: isDone(s) };
  }
  const isTrue = (v) => /^(true|yes|y|1)$/i.test(String(v || "").trim());
  const audienceList = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

  /* First non-empty value among the given (lowercased) header aliases. */
  const pick = (r, ...keys) => {
    for (const k of keys) { const v = r[k]; if (v != null && String(v).trim() !== "") return String(v).trim(); }
    return "";
  };

  /* When the sheet has no audience column, infer it from the step text so the
   * supplier view still shows the right rows. Everyone is "internal" by default. */
  function deriveAudience(phase, action) {
    const set = new Set(["internal"]);
    const hay = `${phase} ${action}`.toLowerCase();
    if (/supplier|reach|rohs|svhc|datasheet|declaration of compliance|component|psu|connector/.test(hay)) set.add("supplier");
    if (/self-declaration|declaration of conformity|technical file|\bdoc\b|ce mark|review/.test(hay)) set.add("reviewer");
    if (/install|manual|\buser\b|sop/.test(hay)) set.add("installer");
    return Array.from(set);
  }

  function normalizeStep(r) {
    const phase = pick(r, "phase") || "Unphased";
    const action = pick(r, "action", "action — what rushroom must do", "action - what rushroom must do");
    const priority = pick(r, "priority");
    const st = statusInfo(pick(r, "status"));
    const presaleRaw = pick(r, "presale");
    const audRaw = pick(r, "audience");
    return {
      step: Number(pick(r, "step")) || 0,
      phase,
      action,
      status: st.label,
      cls: st.cls,
      done: st.done,
      owner: pick(r, "owner", "who does it", "who"),
      where: pick(r, "where / how", "where/how", "where", "how"),
      evidence: pick(r, "output / evidence", "output/evidence", "evidence", "output"),
      folder: pick(r, "folder"),
      priority,
      presale: presaleRaw ? isTrue(presaleRaw) : /blocker|gate/i.test(priority),
      audience: audRaw ? audienceList(audRaw) : deriveAudience(phase, action),
      doc: pick(r, "doc"),
      notes: pick(r, "notes"),
    };
  }

  async function loadSteps() {
    const snapshot = () => (CFG.sampleSteps || []).map(normalizeStep);
    if (CFG.statusSheetCsvUrl) {
      try {
        const res = await fetch(CFG.statusSheetCsvUrl, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const steps = parseCSV(await res.text()).map(normalizeStep).filter((s) => s.step || s.action);
        if (!steps.length) throw new Error("no rows parsed from CSV");
        return { steps, source: "live" };
      } catch (err) {
        // Sheet not shared/published yet, offline, or CORS-blocked → don't break
        // the page; show the bundled snapshot and explain. Switches to live as
        // soon as the Sheet becomes reachable.
        console.warn("Live status fetch failed; using bundled snapshot.", err);
        return { steps: snapshot(), source: "fallback", error: err.message };
      }
    }
    return { steps: snapshot(), source: "sample" };
  }

  /* ---------------- shared renderers ---------------- */
  function statusBadge(step) {
    return el("span", { class: `badge-status ${step.cls}` }, step.status);
  }

  function summaryTiles(steps) {
    const total = steps.length;
    const done = steps.filter((s) => s.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const presaleOpen = steps.filter((s) => s.presale && !s.done).length;
    const blocked = steps.filter((s) => norm(s.status) === "blocked").length;
    return el("div", { class: "summary" }, [
      el("div", { class: "card stat" }, [
        el("h3", {}, "Overall compliance status"),
        el("div", { class: "value" }, `${pct}%`),
        el("div", { class: "progress", "aria-hidden": "true" }, el("span", { style: `width:${pct}%` })),
        el("div", { class: "sub" }, `${done} of ${total} steps complete`),
      ]),
      el("div", { class: "card stat" }, [
        el("h3", {}, "Pre-sale blockers"),
        el("div", { class: "value", style: presaleOpen ? "color:var(--amber)" : "" }, String(presaleOpen)),
        el("div", { class: "sub" }, presaleOpen ? "must clear before first sale" : "all pre-sale steps clear"),
      ]),
      el("div", { class: "card stat" }, [
        el("h3", {}, "Blocked steps"),
        el("div", { class: "value", style: blocked ? "color:var(--red)" : "" }, String(blocked)),
        el("div", { class: "sub" }, blocked ? "need action to unblock" : "nothing blocked"),
      ]),
    ]);
  }

  function phaseOverview(steps) {
    const list = el("div", { class: "phase-bars" });
    for (const [phase, items] of byPhase(steps)) {
      const done = items.filter((s) => s.done).length;
      const pct = items.length ? Math.round((done / items.length) * 100) : 0;
      list.appendChild(el("button", {
        class: "phase-bar phase-jump", type: "button",
        "aria-label": `Jump to ${phase} — ${pct}% complete`,
        onclick: () => jumpToPhase(phase),
      }, [
        el("div", { class: "phase-bar-head" }, [
          el("span", {}, phase),
          el("span", { class: "muted" }, `${done}/${items.length} · ${pct}%`),
        ]),
        el("div", { class: "progress", "aria-hidden": "true" }, el("span", { style: `width:${pct}%` })),
      ]));
    }
    return collapsibleSection("__overview__", "Progress by phase", null, list);
  }

  function blockersPanel(steps) {
    const open = steps.filter((s) => s.presale && !s.done).sort((a, b) => a.step - b.step);
    if (!open.length) {
      return collapsibleSection("__blockers__", "Pre-sale blockers", "all clear",
        el("p", { class: "muted", style: "margin:0" }, "None — every pre-sale step is complete."));
    }
    const ul = el("ul", { class: "blockers" });
    for (const s of open) {
      ul.appendChild(el("li", {}, [
        el("span", { class: "step-no" }, `#${s.step}`),
        el("span", {}, [s.action, " "]),
        statusBadge(s),
      ]));
    }
    return collapsibleSection("__blockers__", "Pre-sale blockers", `${open.length} open`, ul);
  }

  function priorityPill(s) {
    if (s.presale) return el("span", { class: "pill-presale" }, /blocker/i.test(s.priority) ? "blocker" : (s.priority || "pre-sale"));
    if (!s.priority) return el("span", { class: "muted" }, "—");
    return el("span", { class: "pill-priority" }, s.priority);
  }

  const STATUS_OPTIONS = ["Open", "In progress", "Active", "Done", "Blocked"];
  function statusSelect(s, onStatus) {
    const opts = STATUS_OPTIONS.slice();
    if (s.status && !opts.some((o) => o.toLowerCase() === norm(s.status))) opts.unshift(s.status);
    const sel = el("select", { class: `status-select ${s.cls}`, "aria-label": `Status for step ${s.step}` },
      opts.map((o) => el("option", { value: o, selected: norm(o) === norm(s.status) ? "selected" : null }, o)));
    sel.addEventListener("change", () => onStatus(s.step, sel.value, sel));
    return sel;
  }

  function stepsTable(steps, { showAudience = false, editable = false, onStatus = null, onEditStep = null, onDeleteStep = null } = {}) {
    const manage = !!(onEditStep || onDeleteStep);
    const head = ["#", "Action", "Owner", "Status", "Priority"];
    if (showAudience) head.splice(3, 0, "Audience");
    if (manage) head.push("");
    const tbody = el("tbody");
    for (const s of steps) {
      const cells = [
        el("td", { class: "step-no-cell" }, String(s.step)),
        el("td", {}, [
          s.action,
          s.doc ? el("span", {}, [" ", el("a", { href: s.doc, target: "_blank", rel: "noopener" }, "doc ↗")]) : null,
          s.evidence ? el("div", { class: "evidence" }, `Evidence: ${s.evidence}`) : null,
        ]),
        el("td", {}, s.owner || "—"),
      ];
      if (showAudience) cells.push(el("td", { class: "muted" }, s.audience.join(", ") || "—"));
      cells.push(el("td", {}, editable && onStatus ? statusSelect(s, onStatus) : statusBadge(s)));
      cells.push(el("td", {}, priorityPill(s)));
      if (manage) cells.push(el("td", { class: "step-actions" }, [
        onEditStep ? el("button", { class: "btn btn-sm", type: "button", onclick: () => onEditStep(s) }, "Edit") : null,
        onDeleteStep ? el("button", { class: "btn btn-sm doc-del", type: "button", onclick: () => onDeleteStep(s) }, "Delete") : null,
      ]));
      tbody.appendChild(el("tr", {}, cells));
    }
    return el("div", { class: "table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))),
        tbody,
      ]));
  }

  function byPhase(steps) {
    const groups = new Map();
    for (const s of steps) { if (!groups.has(s.phase)) groups.set(s.phase, []); groups.get(s.phase).push(s); }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }

  /* Collapsed-phase memory (persists which phases are folded, across reloads). */
  const COLLAPSE_KEY = "rushroom_portal_collapsed_phases";
  function getCollapsed() { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); } catch { return new Set(); } }
  function setCollapsed(set) { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* ignore */ } }
  function setAllPhases(open) {
    const names = new Set();
    for (const d of $$("details.phase")) {
      d.open = open;
      if (!open) { const n = d.dataset.phase; if (n) names.add(n); }
    }
    setCollapsed(open ? new Set() : names);
  }

  // Expand and smooth-scroll to a phase section (fast navigation from overview).
  function jumpToPhase(phase) {
    const target = $$("details.phase").find((d) => d.dataset.phase === phase);
    if (!target) return;
    target.open = true;
    const c = getCollapsed(); c.delete(phase); setCollapsed(c);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    const s = target.querySelector("summary");
    if (s && s.focus) s.focus({ preventScroll: true });
  }

  // Reusable collapsible block (same look/behaviour/persistence as phases).
  function collapsibleSection(key, title, meta, contentEl) {
    const details = el("details", { class: "phase", "data-phase": key }, [
      el("summary", { class: "phase-summary" }, [
        el("span", { class: "phase-name" }, title),
        meta ? el("span", { class: "phase-meta" }, meta) : null,
      ]),
      el("div", { class: "phase-content" }, contentEl),
    ]);
    if (!getCollapsed().has(key)) details.open = true; // set before listener to avoid a spurious save
    details.addEventListener("toggle", () => {
      const c = getCollapsed();
      if (details.open) c.delete(key); else c.add(key);
      setCollapsed(c);
    });
    return details;
  }

  function phaseToolbar() {
    return el("div", { class: "phase-tools" }, [
      el("button", { class: "btn btn-sm", type: "button", onclick: () => setAllPhases(true) }, "⊞ Expand all"),
      el("button", { class: "btn btn-sm", type: "button", onclick: () => setAllPhases(false) }, "⊟ Collapse all"),
    ]);
  }

  function phaseSections(steps, opts = {}) {
    const collapsed = getCollapsed();
    const frag = el("div");
    for (const [phase, items] of byPhase(steps)) {
      const done = items.filter((s) => s.done).length;
      const pct = items.length ? Math.round((done / items.length) * 100) : 0;
      const details = el("details", { class: "phase", "data-phase": phase }, [
        el("summary", { class: "phase-summary" }, [
          el("span", { class: "phase-name" }, phase),
          el("span", { class: "phase-meta" }, `${done}/${items.length} done · ${pct}%`),
        ]),
        stepsTable(items.sort((a, b) => a.step - b.step), opts),
      ]);
      if (!collapsed.has(phase)) details.open = true; // set before listener to avoid a spurious save
      details.addEventListener("toggle", () => {
        const c = getCollapsed();
        if (details.open) c.delete(phase); else c.add(phase);
        setCollapsed(c);
      });
      frag.appendChild(details);
    }
    return frag;
  }

  // Two top-level sections (the second dimension), each grouped by category.
  const DOC_KINDS = [
    ["template", "Templates & Requirements", "Reference inputs to the work — version-controlled and reusable as starting points."],
    ["operational", "Company as Operates", "The actual operational documentation the AI deviation scan checks against the standards."],
  ];
  /* Blink state + remembered selection for the two-pane browsers.
   * flash(id) marks a freshly uploaded item to blink for 30s. */
  const flashUntil = new Map();   // id -> expiry timestamp (ms)
  const paneSelection = {};       // browser key -> selected item id
  const collapsedCats = new Set(); // "key::heading::category" of collapsed groups (persists across reloads)
  function flash(id) { if (id) flashUntil.set(String(id), Date.now() + 30000); }

  /* Generic Finder-style browser: a left list grouped by heading/category and a
   * right pane showing the selected item's card.
   *   key       — stable string so the selection persists across reloads
   *   tree      — [{ heading, count, action(el|null), hint, categories:[{ name, items:[{id,name,sub,data}] }] }]
   *   renderCard(item) -> element for the right pane
   */
  function twoPaneBrowser(key, tree, renderCard, opts = {}) {
    const root = el("div", { class: "browser" });
    const nav = el("nav", { class: "browser-nav", "aria-label": opts.navLabel || "Files" });
    const main = el("div", { class: "browser-main" });
    root.append(nav, main);

    const items = [];
    const rowById = new Map();
    const select = (item) => {
      if (!item) { main.replaceChildren(el("div", { class: "empty" }, opts.emptyDetail || "Select an item on the left.")); return; }
      paneSelection[key] = item.id;
      for (const [id, r] of rowById) r.classList.toggle("active", id === item.id);
      const r = rowById.get(item.id);
      if (r) { r.classList.remove("blink"); flashUntil.delete(String(item.id)); }
      main.replaceChildren(renderCard(item));
    };

    const setAll = (open) => {
      nav.querySelectorAll("details.browser-cat-group").forEach((d) => {
        d.open = open;
        if (open) collapsedCats.delete(d.dataset.catkey); else collapsedCats.add(d.dataset.catkey);
      });
    };
    // Live search over the left list (name + sub + keywords). Filters rows,
    // auto-opens matching categories, hides empty ones.
    const search = el("input", { type: "search", class: "browser-search-input", placeholder: opts.searchPlaceholder || "Search…", "aria-label": `Search ${opts.navLabel || "list"}` });
    const noResults = el("div", { class: "browser-empty muted", style: "display:none" }, "No matches.");
    const applyFilter = () => {
      const q = search.value.trim().toLowerCase();
      let total = 0;
      nav.querySelectorAll("details.browser-cat-group").forEach((d) => {
        let visible = 0;
        d.querySelectorAll(".browser-row").forEach((row) => {
          const match = !q || (row.dataset.search || "").includes(q);
          row.style.display = match ? "" : "none";
          if (match) visible++;
        });
        d.style.display = (visible || !q) ? "" : "none";
        d.open = q ? visible > 0 : !collapsedCats.has(d.dataset.catkey);
        total += visible;
      });
      noResults.style.display = (q && total === 0) ? "" : "none";
    };
    search.addEventListener("input", applyFilter);
    search.addEventListener("keydown", (e) => { if (e.key === "Escape") { search.value = ""; applyFilter(); } });
    nav.appendChild(el("div", { class: "browser-top" }, [
      search,
      el("div", { class: "browser-tools" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: () => setAll(true) }, "⊞ Expand all"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => setAll(false) }, "⊟ Collapse all"),
      ]),
    ]));

    for (const group of tree) {
      if (group.heading || group.action || typeof group.count === "number") {
        nav.appendChild(el("div", { class: "browser-heading" }, [
          group.heading ? el("span", {}, group.heading) : null,
          typeof group.count === "number" ? el("span", { class: "count" }, `(${group.count})`) : null,
          group.action ? el("span", { class: "browser-head-action" }, group.action) : null,
        ].filter(Boolean)));
      }
      if (group.hint) nav.appendChild(el("div", { class: "browser-hint" }, group.hint));
      if (!group.categories.length) { nav.appendChild(el("div", { class: "browser-empty muted" }, opts.emptyGroup || "None yet.")); continue; }
      for (const cat of group.categories) {
        const catKey = `${key}::${group.heading || ""}::${cat.name}`;
        const rows = [];
        let hasFlash = false;
        for (const item of cat.items) {
          items.push(item);
          const row = el("button", { class: "browser-row", type: "button", "data-id": item.id, title: item.name, "data-search": `${item.name} ${item.sub || ""} ${item.keywords || ""}`.toLowerCase() }, [
            el("span", { class: "browser-row-name" }, item.name),
            item.sub ? el("span", { class: "browser-row-sub muted" }, item.sub) : null,
          ].filter(Boolean));
          rowById.set(item.id, row);
          const exp = flashUntil.get(String(item.id));
          if (exp && exp > Date.now()) { hasFlash = true; row.classList.add("blink"); setTimeout(() => row.classList.remove("blink"), exp - Date.now()); }
          row.addEventListener("click", () => select(item));
          rows.push(row);
        }
        if (hasFlash) collapsedCats.delete(catKey); // keep a flashing category open so its blink is visible
        const details = el("details", { class: "browser-cat-group", "data-catkey": catKey }, [
          el("summary", { class: "browser-cat-summary" }, [
            el("span", { class: "browser-cat-name" }, cat.name),
            el("span", { class: "browser-cat-count" }, String(cat.items.length)),
          ]),
          el("div", { class: "browser-cat-items" }, rows),
        ]);
        if (!collapsedCats.has(catKey)) details.open = true;
        details.addEventListener("toggle", () => {
          if (details.open) collapsedCats.delete(catKey); else collapsedCats.add(catKey);
        });
        nav.appendChild(details);
      }
    }
    nav.appendChild(noResults);

    // Keep the prior selection (or default to the first item). A freshly-uploaded
    // item is left to blink for attention rather than auto-opened, so its blink
    // persists until the user clicks it.
    const initial = items.find((i) => i.id === paneSelection[key]) || items[0];
    select(initial);
    return root;
  }

  // "Open ↗": PDFs open inline in a new browser tab; other types download so the
  // OS opens them in the associated app (Word/Excel) — for editing, search, etc.
  const extOf = (s) => (String(s || "").split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
  const withDownload = (url, name) => (url ? `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(name || "document")}` : url);
  function openHrefFor(url, name, hintPath) {
    return extOf(hintPath || name) === "pdf" ? url : withDownload(url, name); // PDF → inline; else → download
  }
  function openInAppLink(url, name, hintPath) {
    if (!url) return null;
    const isPdf = extOf(hintPath || name) === "pdf";
    return el("a", { class: "linklike std-view", href: openHrefFor(url, name, hintPath), target: "_blank", rel: "noopener", title: isPdf ? "Open the PDF in a new tab" : "Open in the app for this file type (Word, Excel…)" }, "Open ↗");
  }

  function documentLibrary(audienceFilter, docsInput, opts = {}) {
    const source = docsInput || CFG.documents || [];
    const docs = source.filter((d) => !audienceFilter || (d.audience || []).includes(audienceFilter));
    const wrap = el("div");
    if (!docs.length) { wrap.appendChild(el("div", { class: "empty" }, "No documents listed yet.")); return wrap; }

    const openViewer = (d) => {
      if (!window.PortalViewer) return;
      window.PortalViewer.open({ name: d.name, open_url: d.open_url || d.url, storage_path: d.storage_path || d.name });
    };
    const renderDoc = (d) => {
      const versions = d.versions || [];
      const current = versions[0];
      const currentRow = current
        ? el("div", { class: "std-current" }, [
            el("span", { class: "std-vlabel" }, `Current${current.version ? `: ${current.version}` : ""}`),
            el("span", { class: "muted" }, ` · added ${fmtDate(current.created_at)}`),
            current.open_url ? el("button", { class: "linklike std-view", type: "button", onclick: () => openViewer({ ...d, open_url: current.open_url, storage_path: current.storage_path || d.storage_path }) }, "View") : null,
            openInAppLink(current.open_url, current.file_name || d.name, current.storage_path || d.storage_path),
          ])
        : el("div", { class: "std-current muted" }, "No file uploaded yet.");
      const history = versions.length
        ? el("details", { class: "std-history" }, [
            el("summary", {}, `Version history (${versions.length})`),
            el("ul", { class: "std-versions" }, versions.map((v) => {
              const sourceNotes = [];
              if (v.source_document_version) {
                sourceNotes.push(`Based on document version ${v.source_document_version.version || "—"}`);
              }
              if (Array.isArray(v.source_standard_versions) && v.source_standard_versions.length) {
                sourceNotes.push(`Referenced standards: ${v.source_standard_versions.map((sv) => `${sv.standard?.code || sv.standard?.title || "Standard"}${sv.version ? ` ${sv.version}` : ""}`).join(", ")}`);
              }
              return el("li", {}, [
                el("div", {}, [
                  el("span", { class: "std-vlabel" }, v.version || "—"),
                  el("span", { class: "muted" }, ` · added ${fmtDate(v.created_at)}`),
                  v.open_url ? el("button", { class: "linklike std-view", type: "button", onclick: () => openViewer({ ...d, open_url: v.open_url, storage_path: v.storage_path || d.storage_path, name: v.file_name || d.name }) }, "View") : null,
                  openInAppLink(v.open_url, v.file_name || d.name, v.storage_path || d.storage_path),
                ]),
                v.notes ? el("div", { class: "std-notes" }, v.notes) : null,
                sourceNotes.length ? el("div", { class: "std-notes" }, sourceNotes.join(" · ")) : null,
              ]);
            })),
          ])
        : null;
      const link = d.open_url || d.url;
      const openHref = openHrefFor(link, d.name, d.storage_path || d.name);
      const viewAction = link
        ? (window.PortalViewer
          ? el("span", { class: "view-open" }, [
              el("button", { class: "open", type: "button", onclick: () => openViewer(d) }, "View"),
              el("a", { class: "open", href: openHref, target: "_blank", rel: "noopener", title: "Open in the app for this file type" }, "Open ↗"),
            ])
          : el("a", { class: "open", href: openHref, target: "_blank", rel: "noopener" }, "Open ↗"))
        : el("span", { class: "pending" }, "link pending");
      const actions = [
        opts.manage && opts.onNewVersion && d.id ? el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => opts.onNewVersion(d) }, "+ New version") : null,
        opts.manage && opts.onDraft && d.id && (d.kind || "template") === "operational" ? el("button", { class: "btn btn-sm", type: "button", onclick: () => opts.onDraft(d) }, "AI draft") : null,
        opts.manage && opts.onCreateOperational && d.id && (d.kind || "template") === "template" ? el("button", { class: "btn btn-sm", type: "button", onclick: () => opts.onCreateOperational(d) }, "Create as-operates") : null,
        viewAction,
      ].filter(Boolean);
      return el("div", { class: "doc doc-op" }, [
        el("div", {}, [el("div", { class: "name" }, d.name), el("div", { class: "audience" }, `For: ${(d.audience || []).join(", ") || "—"}`)]),
        currentRow,
        history,
        el("div", { class: "doc-actions" }, actions),
      ]);
    };

    const tree = [];
    for (const [kind, label, hint] of DOC_KINDS) {
      const kdocs = docs.filter((d) => (d.kind || "template") === kind);
      if (!kdocs.length && !opts.manage) continue;
      const cats = new Map();
      for (const d of kdocs) { const c = d.category || "Uncategorised"; if (!cats.has(c)) cats.set(c, []); cats.get(c).push(d); }
      const categories = [...cats].map(([name, list]) => ({
        name,
        items: list.map((d) => ({
          id: d.id || d.name,
          name: d.name,
          sub: `${(d.versions || []).length} version${(d.versions || []).length === 1 ? "" : "s"}`,
          keywords: `${d.category || ""} ${(d.audience || []).join(" ")}`,
          data: d,
        })),
      }));
      const action = (opts.manage && opts.onCreateNew && kind === "operational")
        ? el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => opts.onCreateNew() }, "+ New As Operates")
        : null;
      tree.push({ heading: label, count: kdocs.length, action, hint, categories });
    }
    wrap.appendChild(twoPaneBrowser("documents", tree, (item) => renderDoc(item.data), {
      navLabel: "Documents", emptyDetail: "Select a document on the left.", searchPlaceholder: "Search documents…",
    }));
    return wrap;
  }

  function sourceNotice(source) {
    if (source === "live") return null;
    if (source === "fallback") {
      return el("div", { class: "notice" }, [
        "Couldn't reach the live action-plan Sheet yet, so this shows the bundled snapshot. ",
        "Set the Sheet to ", el("strong", {}, "Anyone with the link → Viewer"),
        " (or File → Share → Publish to web → CSV); the dashboard then switches to live automatically.",
      ]);
    }
    return el("div", { class: "notice" },
      "Showing the bundled snapshot of the action plan. Publish the action-plan Google Sheet to CSV and set statusSheetCsvUrl in assets/config.js to read live status.");
  }

  /* ---------------- accessible tabs ---------------- */
  function wireTabs(tablist) {
    const tabs = $$('[role="tab"]', tablist);
    const select = (tab) => {
      for (const t of tabs) {
        const sel = t === tab;
        t.setAttribute("aria-selected", sel ? "true" : "false");
        t.tabIndex = sel ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !sel;
      }
    };
    tablist.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) { select(t); t.focus(); } });
    tablist.addEventListener("keydown", (e) => {
      const idx = tabs.indexOf(document.activeElement);
      if (idx < 0) return;
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = tabs[(idx + 1) % tabs.length];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = tabs[(idx - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); select(next); next.focus(); }
    });
  }

  /* ---------------- API (Supabase) mode ---------------- */
  const API = window.PortalAPI;
  const apiEnabled = () => !!(API && API.configured());

  // Map a DB row from the Edge Function into the same shape the renderers use.
  function stepsFromApi(rows) {
    return (rows || []).map((r) => {
      const n = normalizeStep({
        step: r.step, phase: r.phase, action: r.action, owner: r.owner,
        "where / how": r.where_how, "output / evidence": r.evidence,
        folder: r.folder, priority: r.priority, status: r.status,
        audience: Array.isArray(r.audience) ? r.audience.join(", ") : (r.audience || ""),
      });
      n.updatedBy = r.updated_by || "";
      return n;
    });
  }

  // Login gate backed by the Edge Function (replaces the client-side hash gate).
  function setupApiGate(role, onUnlock) {
    const gate = $("#gate"), appEl = $("#portal-app");
    const reveal = () => {
      gate.hidden = true; appEl.hidden = false; onUnlock();
      const h = appEl.querySelector("h2, h3"); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
    };
    if (API.getToken(role)) { reveal(); return; }
    const form = $("#gate-form"), input = $("#portal-password"), err = $("#gate-error");
    input.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = ""; input.setAttribute("aria-invalid", "false");
      const btn = form.querySelector("button"); btn.disabled = true;
      try {
        await API.login(role, input.value);
        reveal();
      } catch (ex) {
        input.setAttribute("aria-invalid", "true");
        err.textContent = ex.message || "Login failed."; input.select();
      } finally { btn.disabled = false; }
    });
  }

  // File-upload card (suppliers submit declarations; Rushroom can attach files).
  // PUT a file to a signed URL via XHR so we get real upload-progress events.
  function xhrPut(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(file);
    });
  }

  /* An upload field: drag-and-drop zone + themed Choose File + progress bar. The
   * file is uploaded to storage as soon as it is chosen or dropped, showing a
   * progress bar; dependent buttons (registered via register()) stay disabled
   * until the upload has completed. This also makes drag-and-drop robust on
   * browsers that don't allow assigning input.files (the dropped File is used
   * directly, not read back from the input). */
  function uploadZone(role, bucket, opts = {}) {
    const input = el("input", { type: "file", class: "up-file", "aria-label": opts.ariaLabel || "Choose a file" });
    const bar = el("div", { class: "up-progress-bar" });
    const pct = el("span", { class: "up-progress-pct" }, "0%");
    const barWrap = el("div", { class: "up-progress-row", hidden: "" }, [el("div", { class: "up-progress" }, bar), pct]);
    const info = el("div", { class: "dropzone-file muted" }, "No file selected.");
    const zone = el("div", { class: "dropzone" }, [
      el("div", { class: "dropzone-hint" }, [
        el("span", { class: "dropzone-ico", "aria-hidden": "true" }, "⬆"),
        el("span", {}, opts.hint || "Drag & drop a file here, or"),
      ]),
      input, info, barWrap,
    ]);

    let file = null, uploaded = null, uploading = false;
    const gated = []; // { el, requireFile }
    const sync = () => { for (const g of gated) g.el.disabled = uploading || (g.requireFile && !uploaded); };
    const register = (btnEl, requireFile = true) => { gated.push({ el: btnEl, requireFile }); sync(); };

    // Smoothly animated 0→100 progress: the displayed value eases toward a moving
    // target, so even an instant upload visibly counts up; real XHR progress and
    // a steady "trickle" both push the target forward.
    let dispPct = 0, targetPct = 0, rafId = null, trickleId = null, done = false;
    const paint = () => {
      const v = Math.max(0, Math.min(100, dispPct));
      bar.style.width = v.toFixed(1) + "%";
      pct.textContent = Math.round(v) + "%";           // always-updating counter
      if (!done && file) info.textContent = `Uploading “${file.name}”…`;
    };
    const tick = () => {
      const diff = targetPct - dispPct;
      if (diff <= 0.4) {
        dispPct = targetPct; paint(); rafId = null;
        if (done && dispPct >= 100 && file) { info.className = "dropzone-file ok"; info.textContent = `✓ ${file.name} — uploaded`; }
        return;
      }
      dispPct = Math.min(targetPct, dispPct + diff * 0.12 + 0.4);
      paint();
      rafId = requestAnimationFrame(tick);
    };
    const bump = (t) => { targetPct = Math.max(targetPct, Math.min(100, t)); if (rafId == null) rafId = requestAnimationFrame(tick); };
    const stopAnim = () => { if (trickleId) { clearInterval(trickleId); trickleId = null; } if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } };

    const startUpload = async (f) => {
      file = f; uploaded = null; uploading = true; sync();
      stopAnim(); dispPct = 0; targetPct = 0; done = false;
      info.className = "dropzone-file"; barWrap.hidden = false; paint();
      // creep the target toward 90% so the bar always shows steady movement
      trickleId = setInterval(() => { if (!done && targetPct < 90) bump(targetPct + Math.max(1.5, (90 - targetPct) * 0.06)); }, 120);
      try {
        const { signedUrl, path } = await API.signedUploadUrl(API.getToken(role), f.name, bucket);
        await xhrPut(signedUrl, f, (pct) => bump(Math.min(95, pct)));
        if (trickleId) { clearInterval(trickleId); trickleId = null; }
        uploaded = { path, fileName: f.name }; uploading = false; done = true; sync();
        bump(100);
        if (opts.onReady) opts.onReady(uploaded, f);
      } catch (ex) {
        stopAnim();
        uploading = false; uploaded = null; done = false; sync();
        info.className = "dropzone-file err"; info.textContent = `Upload failed: ${ex.message}. Please try again.`;
        barWrap.hidden = true;
      }
    };

    input.addEventListener("change", () => { const f = input.files && input.files[0]; if (f) startUpload(f); });
    const setDrag = (on) => zone.classList.toggle("dragover", on);
    zone.addEventListener("dragenter", (e) => { e.preventDefault(); setDrag(true); });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; setDrag(true); });
    zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget)) setDrag(false); });
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); setDrag(false);
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      try { const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } catch (_) { /* Safari: ignore, we use f directly */ }
      startUpload(f);
    });

    return {
      el: zone, bucket, register,
      getUploaded: () => uploaded,
      getFile: () => file,
      isUploading: () => uploading,
      reset: () => {
        stopAnim();
        file = null; uploaded = null; uploading = false; done = false;
        dispPct = 0; targetPct = 0;
        try { input.value = ""; } catch (_) {}
        bar.style.width = "0%"; pct.textContent = "0%"; barWrap.hidden = true;
        info.className = "dropzone-file muted"; info.textContent = "No file selected.";
        sync();
      },
    };
  }

  /* AI "read the uploaded file and fill fields" button. Uses the file already
   * uploaded by the uploadZone, so it is instant and never re-uploads. */
  function aiAutofill(role, { zone, statusEl, onFill }) {
    const btn = el("button", { class: "btn btn-primary", type: "button" }, "✨ Read file & auto-fill");
    btn.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { statusEl.className = "up-status warn"; statusEl.textContent = zone.isUploading() ? "Please wait — the file is still uploading." : "Add a file first."; return; }
      btn.disabled = true; statusEl.className = "up-status"; statusEl.textContent = "Reading the file with AI…";
      try {
        const meta = await API.suggestFileMetadata(API.getToken(role), { path: up.path, fileName: up.fileName, bucket: zone.bucket });
        onFill(meta, up);
        statusEl.className = "up-status ok";
        statusEl.textContent = meta.summary ? `AI read: ${meta.summary} — review and approve.` : "AI filled the fields — review and approve.";
      } catch (ex) {
        statusEl.className = "up-status err"; statusEl.textContent = `Couldn't read the file: ${ex.message}. You can still fill the fields manually.`;
      } finally { btn.disabled = false; }
    });
    return { btn };
  }

  function uploadCard(role, steps) {
    const zone = uploadZone(role, "uploads", { ariaLabel: "Choose a file to upload" });
    const stepSel = el("select", { class: "up-step", "aria-label": "Related step (optional)" }, [
      el("option", { value: "" }, "— related step (optional) —"),
      ...steps.map((s) => el("option", { value: String(s.step) }, `#${s.step} · ${s.action.slice(0, 60)}`)),
    ]);
    const who = role === "supplier"
      ? el("input", { type: "text", class: "up-who", placeholder: "Your company (optional)", "aria-label": "Your company" })
      : null;
    const note = el("input", { type: "text", class: "up-note", placeholder: "Note (optional)", "aria-label": "Note" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const btn = el("button", { class: "btn btn-primary", type: "button" }, "Upload");
    const af = aiAutofill(role, { zone, statusEl: status, onFill: (meta) => {
      if (meta.summary && !note.value.trim()) note.value = meta.summary;
    } });
    zone.register(af.btn); zone.register(btn);
    btn.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { status.className = "up-status warn"; status.textContent = "Add a file first."; return; }
      btn.disabled = true; status.className = "up-status"; status.textContent = "Saving…";
      try {
        await API.recordUploadRecord(API.getToken(role), { step: stepSel.value || null, note: note.value, supplierLabel: who ? who.value : "", path: up.path, fileName: up.fileName });
        status.className = "up-status ok"; status.textContent = `Uploaded “${up.fileName}”. Thank you.`;
        zone.reset(); note.value = "";
      } catch (ex) {
        btn.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`;
      }
    });
    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Upload a document"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" }, role === "supplier"
        ? "Submit your signed declaration, test reports, datasheets, or RoHS/REACH declarations. The AI can read the file and suggest a note."
        : "Attach a file to the technical file or a specific step. The AI can read the file and suggest a note."),
      zone.el,
      el("div", { class: "upload-fields", style: "margin-top:0.6rem" }, [stepSel, who, note].filter(Boolean)),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.6rem" }, [af.btn, btn]),
      status,
    ]);
  }

  // Rushroom-only: add a file to the document library (stored in Supabase).
  function manageDocumentsCard(role, reload) {
    if (role !== "rushroom") return null;
    const zone = uploadZone(role, "documents", { ariaLabel: "Choose a document to add" });
    const name = el("input", { type: "text", class: "up-text", placeholder: "Display name (defaults to file name)", "aria-label": "Document name" });
    const category = el("input", { type: "text", class: "up-text", placeholder: "Category (e.g. Test reports)", "aria-label": "Category" });
    const kind = el("select", { class: "up-text", "aria-label": "Section" }, [
      el("option", { value: "template" }, "Templates & Requirements"),
      el("option", { value: "operational" }, "Company as Operates (AI-audited)"),
    ]);
    const auds = ["internal", "supplier", "reviewer", "installer"].map((a) => {
      const cb = el("input", { type: "checkbox", value: a, checked: a === "internal" ? "checked" : null });
      return { a, cb, label: el("label", { class: "aud-check" }, [cb, ` ${a}`]) };
    });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const btn = el("button", { class: "btn btn-primary", type: "button" }, "Add document");
    const af = aiAutofill(role, { zone, statusEl: status, onFill: (meta) => {
      if (meta.name) name.value = meta.name;
      if (meta.category) category.value = meta.category;
      if (meta.kind === "template" || meta.kind === "operational") kind.value = meta.kind;
    } });
    zone.register(af.btn); zone.register(btn);
    btn.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { status.className = "up-status warn"; status.textContent = "Add a file first."; return; }
      const audience = auds.filter((c) => c.cb.checked).map((c) => c.a);
      if (!audience.length) audience.push("internal");
      btn.disabled = true; status.className = "up-status"; status.textContent = "Adding…";
      try {
        const res = await API.addDocumentRecord(API.getToken(role), { category: category.value, name: name.value || up.fileName, audience, kind: kind.value, path: up.path, fileName: up.fileName });
        flash(res && res.id);
        status.className = "up-status ok"; status.textContent = `Added “${name.value || up.fileName}”.`;
        zone.reset(); name.value = ""; category.value = "";
        await reload();
      } catch (ex) {
        btn.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`;
      }
    });
    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Manage documents"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" }, "Upload a file — the AI reads its name, category and section for you. Review, then add. Templates can later become As Operates documents without deleting anything."),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Document file"), zone.el]),
      el("div", { style: "margin:0.5rem 0 0.9rem" }, af.btn),
      el("div", { class: "upload-fields" }, [name, category, kind]),
      el("div", { class: "aud-checks" }, auds.map((c) => c.label)),
      el("div", { style: "margin-top:0.75rem" }, btn),
      status,
    ]);
  }

  function createOperationalFromTemplate(templateDoc, role, reload, templates) {
    documentDraftAssistant(null, role, reload, {
      templateDoc,
      templates: templates || [],
      title: `Create As Operates — ${templateDoc.name || "template"}`,
      initialName: `${templateDoc.name || "Template"} — As Operates`,
      mode: "create",
    });
  }

  // Upload a new version of a document (previous versions kept).
  function documentVersionEditor(d, role, reload) {
    const current = (d.versions || [])[0];
    const currentUrl = (current && current.open_url) || d.open_url;
    const currentHint = (current && (current.file_name || current.storage_path)) || d.storage_path || d.name;
    const gdocsReady = !!(window.PortalGDocs && window.PortalGDocs.configured());

    // Shared version metadata (used by both the Google Docs edit and the upload paths).
    const version = el("input", { type: "text", placeholder: "Version label (optional, e.g. 2026-07 or Rev B)" });
    const notes = el("textarea", { rows: "2", placeholder: "What changed (optional)" });

    // ---- Path A: edit the current version in Google Docs, save back as a new version ----
    let gdocId = null;
    const gopen = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "📝 Open current version in Google Docs");
    const gsave = el("button", { class: "btn btn-primary", type: "button" }, "⬆ Save Google Doc as new version");
    const glink = el("span", { style: "font-size:0.85rem" });
    const gstatus = el("p", { class: "up-status", role: "status", "aria-live": "polite", style: "margin:0.4rem 0 0" }, "");
    gsave.disabled = true;
    const gsection = (gdocsReady && currentUrl) ? el("div", { class: "src-section" }, [
      el("div", { class: "src-head" }, "Edit the current version in Google Docs"),
      el("p", { class: "muted", style: "margin:0.1rem 0 0.6rem" }, "Open the current file, edit it in Google Docs, then save it back as a new version — same document and references, nothing else changes."),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [gopen, glink]),
      gstatus,
      el("div", { style: "margin-top:0.5rem" }, gsave),
    ]) : null;

    // ---- Path B: upload a new file ----
    const zone = uploadZone(role, "documents", { ariaLabel: "Choose the new version file" });
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const save = el("button", { class: "btn btn-primary", type: "button" }, "Upload new version");
    const af = aiAutofill(role, { zone, statusEl: note, onFill: (meta) => {
      if (meta.version && !version.value.trim()) version.value = meta.version;
      if (meta.summary && !notes.value.trim()) notes.value = meta.summary;
    } });
    zone.register(af.btn); zone.register(save);

    const form = el("div", { class: "step-form" }, [
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Version label"), version]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Notes"), notes]),
      gsection,
      gsection ? el("div", { class: "muted", style: "text-align:center; margin:0.4rem 0" }, "— or upload a replacement file —") : null,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "File"), zone.el]),
      el("div", {}, af.btn),
      note, el("div", { style: "margin-top:0.5rem" }, save),
    ].filter(Boolean));
    const close = openModal(`New version — ${d.name}`, form);

    save.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { note.className = "up-status warn"; note.textContent = "Add a file first."; return; }
      save.disabled = true; note.className = "up-status"; note.textContent = "Saving…";
      try {
        await API.addDocumentVersionRecord(API.getToken(role), { documentId: d.id, version: version.value, notes: notes.value, path: up.path, fileName: up.fileName });
        flash(d.id); close(); await reload();
      } catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
    });

    gopen.addEventListener("click", async () => {
      if (!currentUrl) { gstatus.className = "up-status warn"; gstatus.textContent = "This document has no current file to edit."; return; }
      const win = window.open("", "_blank"); // opened in the gesture to avoid popup blocking
      gopen.disabled = true; gstatus.className = "up-status"; gstatus.textContent = "Preparing the document in Google Docs…";
      try {
        await window.PortalGDocs.getToken();
        const resp = await fetch(currentUrl);
        if (!resp.ok) throw new Error(`couldn't read the current file (HTTP ${resp.status}) — reopen the library`);
        const buf = await resp.arrayBuffer();
        const ext = extOf(currentHint);
        let blob;
        if (ext === "docx") {
          blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } else if (ext === "md" || ext === "markdown") {
          const text = unescapeUnicode(new TextDecoder().decode(new Uint8Array(buf)));
          await loadScript(MARKED_CDN);
          blob = new Blob([window.marked.parse(text || "")], { type: "text/html" });
        } else if (ext === "html" || ext === "htm" || ext === "txt" || ext === "") {
          const text = unescapeUnicode(new TextDecoder().decode(new Uint8Array(buf)));
          blob = new Blob([text], { type: (ext === "html" || ext === "htm") ? "text/html" : "text/plain" });
        } else {
          if (win && !win.closed) win.close();
          gstatus.className = "up-status err"; gstatus.textContent = `“.${ext}” can't be edited in Google Docs — upload a replacement below instead.`;
          gopen.disabled = false; return;
        }
        const res = await window.PortalGDocs.importDoc(blob, d.name);
        gdocId = res.documentId;
        if (win && !win.closed) win.location.href = res.editUrl; else window.open(res.editUrl, "_blank", "noopener");
        glink.replaceChildren(el("a", { href: res.editUrl, target: "_blank", rel: "noopener", class: "linklike" }, "Open Google Doc ↗"));
        gsave.disabled = false;
        gstatus.className = "up-status ok"; gstatus.textContent = "Opened in Google Docs. Edit there, then Save as new version.";
      } catch (ex) {
        if (win && !win.closed) win.close();
        gstatus.className = "up-status err"; gstatus.textContent = `Couldn't open in Google Docs: ${ex.message}`;
        gopen.disabled = false;
      }
    });

    gsave.addEventListener("click", async () => {
      if (!gdocId) { gstatus.className = "up-status warn"; gstatus.textContent = "Open the document in Google Docs first."; return; }
      gsave.disabled = true; gstatus.className = "up-status"; gstatus.textContent = "Saving the edited document as a new version…";
      try {
        const blob = await window.PortalGDocs.exportDoc(gdocId, "docx");
        const carried = (current && Array.isArray(current.source_standard_versions)) ? current.source_standard_versions.map((sv) => sv && sv.id).filter(Boolean) : [];
        const fileName = `${(d.name || "document").replace(/[^a-z0-9._-]+/gi, "_") || "document"}.docx`;
        await API.addDocumentVersionFile(API.getToken(role), blob, { documentId: d.id, version: version.value, notes: notes.value, fileName, sourceStandardVersionIds: carried });
        flash(d.id); close(); await reload();
      } catch (ex) {
        gsave.disabled = false; gstatus.className = "up-status err"; gstatus.textContent = `Couldn't save the new version: ${ex.message}`;
      }
    });
  }

  function documentDraftAssistant(d, role, reload, options = {}) {
    const templateDoc = options.templateDoc || null;
    const templates = options.templates || [];
    const isCreateMode = options.mode === "create" || !d;
    const defaultName = options.initialName || (d ? d.name : "New As Operates");
    const name = el("input", { type: "text", class: "up-text", value: defaultName, placeholder: "Name of the As Operates document", "aria-label": "As Operates document name" });
    // A generic default name may be auto-replaced when a template is picked.
    if (isCreateMode && !options.initialName) name.dataset.auto = "1";
    const notes = el("textarea", { rows: "3", placeholder: "e.g. reflect the latest requirements, tighten wording, add the sign-off section" });
    const version = el("input", { type: "text", placeholder: "Version label (optional, e.g. Rev C or 2026-08)" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const generate = el("button", { class: "btn btn-primary", type: "button" }, "Generate draft");
    const publish = el("button", { class: "btn btn-primary", type: "button" }, "Publish approved draft");
    const changeList = el("div", { style: "margin-top:0.75rem" });
    const draft = el("textarea", { rows: "12", style: "width:100%; margin-top:0.75rem", placeholder: "The AI-generated draft will appear here" });
    const standardsWrap = el("div", { style: "margin-top:0.4rem" });
    publish.disabled = true;
    // A second Publish button at the bottom, so you can publish right after
    // editing the draft / fetching from Google Docs without scrolling up.
    const publishBottom = el("button", { class: "btn btn-primary", type: "button" }, "✓ Publish approved draft");
    publishBottom.disabled = true;
    const publishStatus = el("p", { class: "up-status", role: "status", "aria-live": "polite", style: "margin:0.5rem 0 0" }, "");
    let draftResult = null;

    // Google Docs round-trip: edit the generated draft in Google Docs, then pull
    // the edited content back before publishing. Shown after a draft exists.
    const gdocEdit = el("button", { class: "btn btn-sm", type: "button" }, "📝 Edit in Google Docs");
    const gdocPublish = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "⬆ Publish from Google Docs (Word)");
    const gdocFetch = el("button", { class: "btn btn-sm", type: "button" }, "↓ Fetch text back");
    const gdocLink = el("span", { style: "font-size:0.85rem" });
    const gdocStatus = el("p", { class: "up-status", role: "status", "aria-live": "polite", style: "margin:0.4rem 0 0" }, "");
    const gdocRow = el("div", { style: "display:none; margin-top:0.6rem" }, [
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [gdocEdit, gdocPublish, gdocFetch, gdocLink]),
      gdocStatus,
    ]);
    gdocFetch.style.display = "none"; gdocPublish.style.display = "none";
    let googleDocId = null;
    const gdocDocName = () => (isCreateMode ? name.value.trim() : (d ? d.name : "")) || "Rushroom compliance draft";

    // Path 1 source — a template picker (create mode) or the base document (update mode).
    let templateSelect = null;
    if (isCreateMode) {
      templateSelect = el("select", { class: "up-text", "aria-label": "Start from a template" });
      templateSelect.appendChild(el("option", { value: "" }, "— none (start from standards and/or context) —"));
      for (const t of templates) templateSelect.appendChild(el("option", { value: t.id }, t.name));
      if (templateDoc && templateDoc.id) templateSelect.value = templateDoc.id;
      templateSelect.addEventListener("change", () => {
        const t = templates.find((x) => x.id === templateSelect.value);
        if (t && (!name.value.trim() || name.dataset.auto === "1")) { name.value = `${t.name} — As Operates`; name.dataset.auto = "1"; }
        else if (!templateSelect.value && name.dataset.auto === "1") { name.value = "New As Operates"; }
      });
    }
    const selectedTemplateId = () => (templateSelect ? (templateSelect.value || "") : "");

    const source1 = isCreateMode
      ? el("label", { class: "form-row src-row" }, [
          el("span", { class: "form-label" }, "1 · Start from a template"),
          templates.length ? templateSelect : el("div", { class: "muted" }, "No templates available — you can still build from standards and/or context below."),
        ])
      : el("div", { class: "src-row" }, [
          el("span", { class: "form-label" }, "1 · Base document"),
          el("div", { class: "muted" }, `${d.name} — its current version is the starting point.`),
        ]);
    const source2 = el("div", { class: "src-row" }, [
      el("span", { class: "form-label" }, "2 · Reference standards & regulations"),
      el("div", { class: "muted", style: "margin:0.1rem 0 0.35rem" }, "Only standards with an uploaded version appear here. Add them in the Standards & Regulations section first."),
      standardsWrap,
    ]);
    const source3 = el("label", { class: "form-row src-row" }, [
      el("span", { class: "form-label" }, "3 · Context / change request"),
      notes,
    ]);
    const sourceSection = el("div", { class: "src-section" }, [
      el("div", { class: "src-head" }, "Source material — combine any of these"),
      el("p", { class: "muted", style: "margin:0.1rem 0 0.7rem" }, isCreateMode
        ? "Build a new As Operates document from a template, from one or more standards/regulations, or from both — plus optional context."
        : "Update this document from its current version, optionally guided by standards/regulations and your change notes."),
      source1, source2, source3,
    ]);

    const form = el("div", { class: "step-form" }, [
      isCreateMode ? el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Document name"), name]) : null,
      sourceSection,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Version label"), version]),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem" }, [generate, publish]),
      status,
      el("div", { style: "margin-top:1rem" }, [el("strong", {}, "Suggested changes"), changeList]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Draft text"), draft]),
      gdocRow,
      el("div", { style: "margin-top:1rem; border-top:1px solid var(--border); padding-top:0.85rem" }, [
        el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [publishBottom]),
        publishStatus,
      ]),
    ].filter(Boolean));

    const close = openModal(options.title || (d ? `AI draft — ${d.name}` : "New As Operates document"), form);
    (isCreateMode ? name : notes).focus();

    const loadStandards = async () => {
      standardsWrap.replaceChildren(el("div", { class: "muted" }, "Loading standards…"));
      try {
        const payload = await API.standards(API.getToken(role));
        const standards = (payload.standards || []).filter((s) => Array.isArray(s.versions) && s.versions.length);
        if (!standards.length) {
          standardsWrap.replaceChildren(el("div", { class: "muted" }, "No uploaded standards or regulations are available yet. Add them in the Standards & Regulations section first."));
          return;
        }
        const list = el("div", { style: "display:grid; gap:0.8rem; margin-top:0.2rem" });
        for (const std of standards) {
          const latest = std.versions[0];
          const checkbox = el("input", { type: "checkbox", value: std.id });
          const select = el("select", { class: "up-text", disabled: "disabled", style: "margin-top:0.25rem; width:100%;" },
            std.versions.map((v) => el("option", { value: v.id, selected: v.id === latest.id ? "selected" : null }, `${v.version || "version"}${v.effective_date ? ` · ${v.effective_date}` : ""}`))
          );
          checkbox.addEventListener("change", () => { select.disabled = !checkbox.checked; });
          const item = el("div", { style: "border:1px solid var(--border); padding:0.75rem; border-radius:0.4rem;" }, [
            el("label", { style: "display:flex; gap:0.5rem; align-items:flex-start;" }, [
              checkbox,
              el("span", {}, [
                el("strong", {}, std.code || std.title || "Standard"),
                el("div", { class: "muted", style: "font-size:0.82rem; margin-top:0.1rem" }, `${std.title || ""}${latest?.version ? ` · ${latest.version}` : ""}`),
              ]),
            ]),
            el("div", { style: "display:flex; flex-direction:column; gap:0.25rem; margin-top:0.5rem" }, [
              el("span", { class: "muted", style: "font-size:0.82rem;" }, "Select the exact standard version to use for drafting."),
              select,
            ]),
          ]);
          list.appendChild(item);
        }
        standardsWrap.replaceChildren(list);
      } catch (ex) {
        standardsWrap.replaceChildren(el("div", { class: "error" }, `Couldn't load standards: ${ex.message}`));
      }
    };
    loadStandards();

    generate.addEventListener("click", async () => {
      const context = notes.value.trim();
      const selectedStandardVersionIds = Array.from(standardsWrap.querySelectorAll("input[type='checkbox']"))
        .filter((cb) => cb.checked)
        .map((cb) => {
          const select = cb.closest("div")?.querySelector("select");
          return select ? select.value : cb.value;
        })
        .filter(Boolean);
      const tmplId = selectedTemplateId();
      if (!context && !selectedStandardVersionIds.length && !tmplId && !d) {
        status.className = "up-status warn"; status.textContent = "Choose a template, select one or more standards/regulations, or add context first."; return;
      }
      generate.disabled = true; publish.disabled = true; publishBottom.disabled = true; status.className = "up-status"; status.textContent = "Generating draft…";
      try {
        draftResult = await API.suggestDocumentVersion(API.getToken(role), {
          documentId: d ? d.id : null,
          templateDocumentId: tmplId || null,
          notes: context,
          preferredVersion: version.value.trim(),
          sourceStandardVersionIds: selectedStandardVersionIds,
        });
        const proposals = Array.isArray(draftResult.proposedChanges) ? draftResult.proposedChanges : [];
        changeList.replaceChildren();
        if (proposals.length) {
          const items = proposals.map((c) => {
            const checkbox = el("input", { type: "checkbox", checked: "checked" });
            checkbox.dataset.title = c.title || "Change";
            return el("label", { style: "display:flex; gap:0.5rem; align-items:flex-start; margin-bottom:0.5rem" }, [
              checkbox,
              el("span", {}, [el("strong", {}, c.title || "Change"), el("div", { class: "muted", style: "margin-top:0.2rem" }, c.description || "")]),
            ]);
          });
          changeList.append(...items);
        } else {
          changeList.appendChild(el("div", { class: "muted" }, "No specific change list was returned. You can still publish the draft as-is."));
        }
        draft.value = unescapeUnicode(draftResult.draftText || "");
        status.className = "up-status ok"; status.textContent = draftResult.summary || "Draft ready for review.";
        publish.disabled = false; publishBottom.disabled = false;
        // fresh draft → reset any prior Google Doc round-trip (only if configured)
        googleDocId = null;
        gdocRow.style.display = (window.PortalGDocs && window.PortalGDocs.configured()) ? "block" : "none";
        gdocFetch.style.display = "none"; gdocPublish.style.display = "none"; gdocLink.replaceChildren(); gdocStatus.textContent = "";
      } catch (ex) {
        status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`;
      } finally {
        generate.disabled = false;
      }
    });

    // Common publish parameters shared by the text and the Google-Docs-file paths.
    const gatherPublish = () => {
      const approved = Array.from(changeList.querySelectorAll("input[type='checkbox']")).filter((cb) => cb.checked).map((cb) => cb.dataset.title || "change").filter(Boolean);
      const selectedStandardVersionIds = Array.from(standardsWrap.querySelectorAll("input[type='checkbox']")).filter((cb) => cb.checked).map((cb) => { const s = cb.closest("div")?.querySelector("select"); return s ? s.value : cb.value; }).filter(Boolean);
      return {
        documentId: d ? d.id : null,
        newDocumentName: isCreateMode ? name.value.trim() : null,
        templateDocumentId: selectedTemplateId() || null,
        version: version.value.trim() || (draftResult && draftResult.versionHint) || "AI draft",
        notes: `Approved changes: ${approved.join(", ") || "none"}\n${notes.value.trim()}`,
        approvedChanges: approved,
        sourceStandardVersionIds: selectedStandardVersionIds,
      };
    };
    const baseFileName = () => ((isCreateMode ? name.value.trim() : (d ? d.name : "document")) || "document").replace(/[^a-z0-9._-]+/gi, "_") || "document";

    const doPublish = async (statusEl) => {
      if (!draftResult) { statusEl.className = "up-status warn"; statusEl.textContent = "Generate a draft first."; return; }
      const finalText = draft.value.trim();
      if (!finalText) { statusEl.className = "up-status warn"; statusEl.textContent = "The draft text is empty."; return; }
      publish.disabled = true; publishBottom.disabled = true; statusEl.className = "up-status"; statusEl.textContent = "Publishing draft…";
      try {
        await API.publishDocumentDraft(API.getToken(role), { ...gatherPublish(), draftText: finalText, fileName: `${baseFileName()}.md` });
        close(); await reload();
      } catch (ex) {
        publish.disabled = false; publishBottom.disabled = false; statusEl.className = "up-status err"; statusEl.textContent = `Failed: ${ex.message}`;
      }
    };
    publish.addEventListener("click", () => doPublish(status));
    publishBottom.addEventListener("click", () => doPublish(publishStatus));

    gdocEdit.addEventListener("click", async () => {
      const text = draft.value.trim();
      if (!text) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Generate or write a draft first."; return; }
      // Open the tab synchronously (inside the click gesture) so the browser
      // doesn't block it as a popup; we point it at the Doc once it's created.
      if (!window.PortalGDocs || !window.PortalGDocs.configured()) { gdocStatus.className = "up-status err"; gdocStatus.textContent = "Google Docs isn't set up yet."; return; }
      // Pre-open the tab inside the click gesture so it isn't popup-blocked.
      const win = window.open("", "_blank");
      gdocEdit.disabled = true; gdocStatus.className = "up-status"; gdocStatus.textContent = "Opening Google — approve access if prompted…";
      try {
        await window.PortalGDocs.getToken(); // consent popup on first use (kept in the gesture)
        const res = await window.PortalGDocs.createDoc(gdocDocName(), draft.value);
        googleDocId = res.documentId;
        if (draftResult) draftResult.googleDocId = googleDocId;
        if (win && !win.closed) win.location.href = res.editUrl; else window.open(res.editUrl, "_blank", "noopener");
        gdocFetch.style.display = "inline-flex"; gdocPublish.style.display = "inline-flex";
        gdocLink.replaceChildren(el("a", { href: res.editUrl, target: "_blank", rel: "noopener", class: "linklike" }, "Open Google Doc ↗"));
        gdocStatus.className = "up-status ok"; gdocStatus.textContent = "Google Doc created in your Drive and opened in a new tab. Edit there, then “Publish from Google Docs” to save it as a formatted Word document.";
      } catch (ex) {
        if (win && !win.closed) win.close();
        gdocStatus.className = "up-status err"; gdocStatus.textContent = `Couldn't create the Google Doc: ${ex.message}`;
      } finally { gdocEdit.disabled = false; }
    });

    gdocFetch.addEventListener("click", async () => {
      if (!googleDocId) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Create the Google Doc first."; return; }
      gdocFetch.disabled = true; gdocStatus.className = "up-status"; gdocStatus.textContent = "Fetching the edited version…";
      try {
        const content = await window.PortalGDocs.fetchDoc(googleDocId);
        draft.value = unescapeUnicode(content || "");
        gdocStatus.className = "up-status ok"; gdocStatus.textContent = "Fetched the edited text into the draft (plain text). To keep full formatting, use “Publish from Google Docs” instead.";
      } catch (ex) {
        gdocStatus.className = "up-status err"; gdocStatus.textContent = `Couldn't fetch the edited version: ${ex.message}`;
      } finally { gdocFetch.disabled = false; }
    });

    gdocPublish.addEventListener("click", async () => {
      if (!googleDocId) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Create the Google Doc first."; return; }
      if (!draftResult) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Generate a draft first."; return; }
      gdocPublish.disabled = true; gdocStatus.className = "up-status"; gdocStatus.textContent = "Exporting the Google Doc as Word and publishing…";
      try {
        const blob = await window.PortalGDocs.exportDoc(googleDocId, "docx");
        await API.publishDocumentFile(API.getToken(role), blob, { ...gatherPublish(), fileName: `${baseFileName()}.docx` });
        close(); await reload();
      } catch (ex) {
        gdocPublish.disabled = false; gdocStatus.className = "up-status err"; gdocStatus.textContent = `Couldn't publish from Google Docs: ${ex.message}`;
      }
    });
  }

  // Generic accessible modal (reuses the viewer's overlay/dialog styling).
  function openModal(title, contentEl) {
    const lastFocus = document.activeElement;
    const closeModal = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    const closeBtn = el("button", { class: "btn btn-sm", type: "button", onclick: closeModal }, "✕ Close");
    const dialog = el("div", { class: "viewer-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("div", { class: "viewer-head" }, [el("h3", { class: "viewer-title" }, title), el("span", { class: "spacer" }), closeBtn]),
      el("div", { class: "modal-body" }, contentEl),
    ]);
    const overlay = el("div", { class: "viewer-overlay", onclick: (e) => { if (e.target === overlay) closeModal(); } }, dialog);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    return closeModal;
  }

  // Add / edit a plan step (Rushroom). `existing` null = add a new step.
  function stepEditor(existing, phases, onSave) {
    const v = existing || {};
    const row = (labelText, input) => el("label", { class: "form-row" }, [el("span", { class: "form-label" }, labelText), input]);
    const phaseList = el("datalist", { id: "phase-list" }, (phases || []).map((p) => el("option", { value: p })));
    const prioList = el("datalist", { id: "prio-list" }, ["Foundation", "High", "High — gate", "BLOCKER", "Medium", "Conditional", "Ongoing", "Annual"].map((p) => el("option", { value: p })));
    const phase = el("input", { type: "text", value: v.phase || "", list: "phase-list", placeholder: "e.g. 11. New regulations" });
    const action = el("textarea", { rows: "3", placeholder: "What must Rushroom do…" }, v.action || "");
    const owner = el("input", { type: "text", value: v.owner || "", placeholder: "Who does it" });
    const priority = el("input", { type: "text", value: v.priority || "", list: "prio-list", placeholder: "e.g. High, BLOCKER" });
    const status = el("select", {}, STATUS_OPTIONS.map((o) => el("option", { value: o, selected: norm(o) === norm(v.status || "Open") ? "selected" : null }, o)));
    const evidence = el("input", { type: "text", value: v.evidence || "", placeholder: "Output / evidence" });
    const where = el("input", { type: "text", value: v.where || "", placeholder: "Where / how" });
    const auds = ["internal", "supplier", "reviewer", "installer"].map((a) => {
      const cb = el("input", { type: "checkbox", value: a, checked: (v.audience || ["internal"]).includes(a) ? "checked" : null });
      return { a, cb, label: el("label", { class: "aud-check" }, [cb, ` ${a}`]) };
    });
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const save = el("button", { class: "btn btn-primary", type: "button" }, existing ? "Save changes" : "Add step");
    const form = el("div", { class: "step-form" }, [
      phaseList, prioList,
      row("Phase", phase), row("Action", action), row("Owner", owner),
      row("Priority", priority), row("Status", status), row("Evidence", evidence), row("Where / how", where),
      el("div", { class: "form-row" }, [el("span", { class: "form-label" }, "Audience"), el("div", { class: "aud-checks" }, auds.map((c) => c.label))]),
      note, el("div", { style: "margin-top:0.5rem" }, save),
    ]);
    const close = openModal(existing ? `Edit step #${existing.step}` : "Add a step", form);
    phase.focus();
    save.addEventListener("click", async () => {
      const actionText = action.value.trim();
      if (!actionText) { note.className = "up-status warn"; note.textContent = "Action text is required."; return; }
      const audience = auds.filter((c) => c.cb.checked).map((c) => c.a);
      const fields = { phase: phase.value.trim(), actionText, owner: owner.value.trim(), priority: priority.value.trim(), status: status.value, evidence: evidence.value.trim(), where: where.value.trim(), audience: audience.length ? audience : ["internal"] };
      save.disabled = true; note.className = "up-status"; note.textContent = "Saving…";
      try { await onSave(fields); close(); }
      catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
    });
  }

  // Rushroom-only: list of supplier uploads with signed download links.
  async function uploadsReview(role, reload) {
    if (role !== "rushroom") return null;
    const wrap = el("div", { class: "card" }, el("h3", {}, "Supplier uploads"));
    try {
      const { uploads } = await API.listUploads(API.getToken(role));
      if (!uploads || !uploads.length) { wrap.appendChild(el("p", { class: "muted", style: "margin:0" }, "No uploads yet.")); return wrap; }
      const onDelete = async (u) => {
        if (!confirm(`Delete upload “${u.file_name}”? This removes the file permanently.`)) return;
        try { await API.deleteUpload(API.getToken(role), u.id); await reload(); }
        catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
      };
      const list = el("ul", { class: "uploads" });
      for (const u of uploads) {
        const ext = (u.file_name || "").split(".").pop().toLowerCase();
        const canView = u.download_url && window.PortalViewer && ["pdf", "docx", "xlsx", "xls", "csv"].includes(ext);
        list.appendChild(el("li", {}, [
          canView
            ? el("button", { class: "linklike", type: "button", onclick: () => window.PortalViewer.open({ name: u.file_name, open_url: u.download_url, storage_path: u.file_name }) }, u.file_name)
            : (u.download_url ? el("a", { href: u.download_url, target: "_blank", rel: "noopener" }, u.file_name) : el("span", {}, u.file_name)),
          el("span", { class: "muted" }, ` — ${u.supplier_label || u.uploaded_role}${u.step ? ` · step #${u.step}` : ""}${u.note ? ` · ${u.note}` : ""}`),
          canView ? el("span", { class: "muted" }, [" · ", el("a", { href: u.download_url, target: "_blank", rel: "noopener" }, "download")]) : null,
          u.id ? el("span", {}, [" · ", el("button", { class: "linklike std-del", type: "button", onclick: () => onDelete(u) }, "delete")]) : null,
        ]));
      }
      wrap.appendChild(list);
    } catch (ex) {
      wrap.appendChild(el("p", { class: "error", style: "margin:0" }, `Couldn't load uploads: ${ex.message}`));
    }
    return wrap;
  }

  /* ---------------- Standards & Regulations register ---------------- */
  const fmtDate = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleDateString("en-GB"); } catch { return iso; } };
  const fmtDateTime = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleString("en-GB"); } catch { return iso; } };
  const viewFile = (v) => window.PortalViewer && window.PortalViewer.open({ name: v.file_name, open_url: v.open_url, storage_path: v.file_name });

  async function deleteStandard(s, role, reload) {
    if (!confirm(`Delete standard “${s.code || s.title}” and all its versions?`)) return;
    try { await API.deleteStandard(API.getToken(role), s.id); await reload(); } catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
  }
  async function deleteStandardVersion(v, role, reload) {
    if (!confirm(`Delete version “${v.version || v.file_name}”?`)) return;
    try { await API.deleteStandardVersion(API.getToken(role), v.id); await reload(); } catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
  }

  function addStandardCard(role, reload) {
    const code = el("input", { type: "text", class: "up-text", placeholder: "Code (e.g. EN 60598-1)" });
    const title = el("input", { type: "text", class: "up-text", placeholder: "Title" });
    const category = el("input", { type: "text", class: "up-text", placeholder: "Category (e.g. LVD, EMC)" });
    const version = el("input", { type: "text", class: "up-text", placeholder: "Version (e.g. 2015+A1:2022)" });
    const eff = el("input", { type: "text", class: "up-text", placeholder: "Effective date (optional)" });
    const auds = ["internal", "supplier", "reviewer", "installer"].map((a) => {
      const cb = el("input", { type: "checkbox", value: a, checked: a === "internal" ? "checked" : null });
      return { a, cb, label: el("label", { class: "aud-check" }, [cb, ` ${a}`]) };
    });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const zone = uploadZone(role, "standards", { ariaLabel: "Standard or regulation file" });
    const autofill = el("button", { class: "btn btn-primary", type: "button" }, "✨ Read file & auto-fill");
    const btn = el("button", { class: "btn btn-primary", type: "button" }, "Approve & add standard");
    zone.register(autofill);        // needs an uploaded file
    zone.register(btn, false);      // a file is optional; only block while uploading

    autofill.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { status.className = "up-status warn"; status.textContent = zone.isUploading() ? "Please wait — the file is still uploading." : "Add a file first."; return; }
      autofill.disabled = true; status.className = "up-status"; status.textContent = "Reading the file with AI…";
      try {
        const meta = await API.suggestStandardMetadata(API.getToken(role), { path: up.path, fileName: up.fileName });
        if (meta.code) code.value = meta.code;
        if (meta.title) title.value = meta.title;
        if (meta.category) category.value = meta.category;
        if (meta.version) version.value = meta.version;
        if (meta.effectiveDate) eff.value = meta.effectiveDate;
        status.className = "up-status ok";
        status.textContent = meta.summary ? `AI read: ${meta.summary} — review the fields and approve.` : "AI filled the fields — review and approve.";
      } catch (ex) {
        status.className = "up-status err"; status.textContent = `Couldn't read the file: ${ex.message}. You can still fill the fields manually.`;
      } finally { autofill.disabled = false; }
    });

    btn.addEventListener("click", async () => {
      if (!code.value.trim() && !title.value.trim()) { status.className = "up-status warn"; status.textContent = "Enter a code or title (or auto-fill from a file)."; return; }
      const audience = auds.filter((c) => c.cb.checked).map((c) => c.a);
      btn.disabled = true; status.className = "up-status"; status.textContent = "Saving…";
      try {
        const up = zone.getUploaded(); // attach the uploaded file, if any
        const { id } = await API.addStandard(API.getToken(role), { code: code.value, title: title.value, category: category.value, audience: audience.length ? audience : ["internal"] });
        if (up && id) {
          await API.addStandardVersionRecord(API.getToken(role), { standardId: id, version: version.value, effectiveDate: eff.value, notes: "", path: up.path, fileName: up.fileName });
        }
        flash(id);
        code.value = title.value = category.value = version.value = eff.value = ""; zone.reset();
        await reload();
      } catch (ex) { btn.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`; }
    });

    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Add a standard / regulation"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" }, "Upload the standard file — the AI reads its code, title, category and version for you. Review the fields, then approve to add it. Every upload is kept for a full revision trail."),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Standard file"), zone.el]),
      el("div", { style: "margin:0.5rem 0 0.9rem" }, autofill),
      el("div", { class: "upload-fields" }, [code, title, category]),
      el("div", { class: "upload-fields", style: "margin-top:0.5rem" }, [version, eff]),
      el("div", { class: "aud-checks" }, auds.map((c) => c.label)),
      el("div", { style: "margin-top:0.75rem" }, btn),
      status,
    ]);
  }

  function standardVersionEditor(s, role, reload) {
    const zone = uploadZone(role, "standards", { ariaLabel: "Choose the standard file" });
    const version = el("input", { type: "text", placeholder: "e.g. 2015+A1:2022 or Rev 3" });
    const eff = el("input", { type: "text", placeholder: "Effective date (optional)" });
    const notes = el("textarea", { rows: "3", placeholder: "What changed in this revision (optional)" });
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const save = el("button", { class: "btn btn-primary", type: "button" }, "Upload version");
    const af = aiAutofill(role, { zone, statusEl: note, onFill: (meta) => {
      if (meta.version && !version.value.trim()) version.value = meta.version;
      if (meta.effectiveDate && !eff.value.trim()) eff.value = meta.effectiveDate;
      if (meta.summary && !notes.value.trim()) notes.value = meta.summary;
    } });
    zone.register(af.btn); zone.register(save);
    const form = el("div", { class: "step-form" }, [
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "File"), zone.el]),
      el("div", {}, af.btn),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Version"), version]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Effective date"), eff]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Revision notes"), notes]),
      note, el("div", { style: "margin-top:0.5rem" }, save),
    ]);
    const close = openModal(`New version — ${s.code || s.title || "standard"}`, form);
    save.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { note.className = "up-status warn"; note.textContent = "Add a file first."; return; }
      save.disabled = true; note.className = "up-status"; note.textContent = "Saving…";
      try {
        await API.addStandardVersionRecord(API.getToken(role), { standardId: s.id, version: version.value, effectiveDate: eff.value, notes: notes.value, path: up.path, fileName: up.fileName });
        flash(s.id); close(); await reload();
      } catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
    });
  }

  function standardCard(s, role, reload) {
    const versions = s.versions || []; // newest first (server-ordered)
    const current = versions[0];
    const manage = role === "rushroom";
    const head = el("div", { class: "std-head" }, [
      el("div", {}, [
        el("div", { class: "std-title" }, [el("strong", {}, s.code || "(no code)"), s.title ? el("span", { class: "muted" }, ` — ${s.title}`) : null]),
        el("div", { class: "std-meta" }, [
          s.category ? el("span", { class: "pill-priority" }, s.category) : null,
          el("span", { class: "muted" }, ` ${versions.length} version${versions.length === 1 ? "" : "s"}`),
        ]),
      ]),
      manage ? el("div", { class: "std-actions" }, [
        el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => standardVersionEditor(s, role, reload) }, versions.length ? "+ New version" : "Upload file"),
        el("button", { class: "btn btn-sm doc-del", type: "button", onclick: () => deleteStandard(s, role, reload) }, "Delete"),
      ]) : null,
    ]);
    const currentEl = current
      ? el("div", { class: "std-current" }, [
          el("span", { class: "std-vlabel" }, `Current: ${current.version || "—"}`),
          current.effective_date ? el("span", { class: "muted" }, ` · effective ${current.effective_date}`) : null,
          el("span", { class: "muted" }, ` · added ${fmtDate(current.created_at)}`),
          current.open_url ? el("button", { class: "linklike std-view", type: "button", onclick: () => viewFile(current) }, "View") : null,
          openInAppLink(current.open_url, current.file_name || s.code || s.title, current.storage_path),
        ])
      : el("div", { class: "std-current" }, [
          el("span", { class: "muted" }, "No file uploaded yet."),
          manage ? el("button", { class: "linklike std-view", type: "button", onclick: () => standardVersionEditor(s, role, reload) }, "Upload file") : null,
        ]);
    const history = versions.length
      ? el("details", { class: "std-history" }, [
          el("summary", {}, `Revision history (${versions.length})`),
          el("ul", { class: "std-versions" }, versions.map((v) => el("li", {}, [
            el("div", {}, [
              el("span", { class: "std-vlabel" }, v.version || "—"),
              v.effective_date ? el("span", { class: "muted" }, ` · effective ${v.effective_date}`) : null,
              el("span", { class: "muted" }, ` · added ${fmtDate(v.created_at)}`),
              v.open_url ? el("button", { class: "linklike std-view", type: "button", onclick: () => viewFile(v) }, "View") : null,
              openInAppLink(v.open_url, v.file_name || s.code || s.title, v.storage_path),
              manage ? el("button", { class: "linklike std-del", type: "button", onclick: () => deleteStandardVersion(v, role, reload) }, "delete") : null,
            ]),
            v.notes ? el("div", { class: "std-notes" }, v.notes) : null,
          ]))),
        ])
      : null;
    return el("div", { class: "card std-card" }, [head, currentEl, history]);
  }

  async function renderStandards(role, mount) {
    mount.replaceChildren(el("div", { class: "loading" }, "Loading standards…"));
    let payload;
    try { payload = await API.standards(API.getToken(role)); }
    catch (ex) {
      if (/auth/i.test(ex.message)) { API.clearToken(role); location.reload(); return; }
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load standards: ${ex.message}`)); return;
    }
    const standards = payload.standards || [];
    const reload = () => renderStandards(role, mount);
    let browser;
    if (standards.length) {
      const cats = new Map();
      for (const s of standards) { const c = s.category || "Uncategorised"; if (!cats.has(c)) cats.set(c, []); cats.get(c).push(s); }
      const categories = [...cats].map(([name, list]) => ({
        name,
        items: list.map((s) => ({
          id: s.id,
          name: s.code || s.title || "Standard",
          sub: s.title && s.code ? s.title : `${(s.versions || []).length} version${(s.versions || []).length === 1 ? "" : "s"}`,
          keywords: `${s.code || ""} ${s.title || ""} ${s.category || ""}`,
          data: s,
        })),
      }));
      browser = twoPaneBrowser("standards", [{ heading: "Register", count: standards.length, categories }],
        (item) => standardCard(item.data, role, reload),
        { navLabel: "Standards & regulations", emptyDetail: "Select a standard on the left.", searchPlaceholder: "Search code, title, category…" });
    } else {
      browser = el("div", { class: "empty" }, role === "rushroom" ? "No standards yet — add one above." : "No standards shared with you yet.");
    }
    const frag = el("div", {}, [
      role === "rushroom" ? addStandardCard(role, reload) : null,
      el("div", { class: "notice" }, "Version-controlled register of the standards and regulations this product must meet. Every uploaded revision is kept, so the history stays fully traceable."),
      browser,
    ].filter(Boolean));
    mount.replaceChildren(...frag.childNodes);
  }

  /* ---------------- AI Deviation Monitoring (Rushroom) ---------------- */
  const SEV_ORDER = ["Critical", "High", "Medium", "Low", "Info"];
  async function renderDeviations(role, mount) {
    if (role !== "rushroom") { mount.replaceChildren(el("div", { class: "empty" }, "Not available for this role.")); return; }
    mount.replaceChildren(el("div", { class: "loading" }, "Loading…"));
    let payload;
    try { payload = await API.deviations(API.getToken(role)); }
    catch (ex) {
      if (/auth/i.test(ex.message)) { API.clearToken(role); location.reload(); return; }
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`)); return;
    }
    const reload = () => renderDeviations(role, mount);
    const scan = payload.scan;
    const findings = payload.findings || [];

    const statusEl = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const runBtn = el("button", { class: "btn btn-primary", type: "button" }, "⟳ Run AI scan");
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true; statusEl.className = "up-status";
      statusEl.textContent = "Analysing documents against standards with Claude — this can take up to a minute, please wait…";
      try { await API.runDeviationScan(API.getToken(role)); await reload(); }
      catch (ex) { runBtn.disabled = false; statusEl.className = "up-status err"; statusEl.textContent = `Scan failed: ${ex.message}`; }
    });

    const head = el("div", { class: "card upload-card" }, [
      el("h3", {}, "AI deviation monitoring"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" },
        "Uses the Claude API to compare every document in the library against the standards register and lists deviations by severity. Uploads and scans are manual — a human decides when to run it."),
      el("div", {}, runBtn),
      statusEl,
      scan ? el("div", { class: "scan-meta muted" }, `Last scan: ${fmtDateTime(scan.created_at)} · ${scan.model || ""} · ${scan.docs_scanned} documents vs ${scan.standards_scanned} standards`) : null,
    ]);

    const body = el("div");
    if (!scan) {
      body.appendChild(el("div", { class: "empty" }, "No scan yet — click “Run AI scan” to check your documents against the standards."));
    } else {
      if (scan.summary) body.appendChild(el("div", { class: "notice" }, scan.summary));
      const counts = scan.counts || {};
      body.appendChild(el("div", { class: "sev-summary" }, SEV_ORDER.map((sev) =>
        el("span", { class: `sev-chip sev-${sev.toLowerCase()}` }, `${sev}: ${counts[sev] || 0}`))));
      if (!findings.length) {
        body.appendChild(el("div", { class: "notice ok" }, "No deviations found in this scan."));
      } else {
        const bySev = {};
        for (const f of findings) (bySev[f.severity] || (bySev[f.severity] = [])).push(f);
        for (const sev of SEV_ORDER) {
          const items = bySev[sev];
          if (!items || !items.length) continue;
          const group = el("div", { class: "sev-group" }, el("h3", { class: `sev-head sev-${sev.toLowerCase()}` }, `${sev} (${items.length})`));
          for (const f of items) {
            group.appendChild(el("div", { class: `finding sev-border-${sev.toLowerCase()}` }, [
              el("div", { class: "finding-title" }, f.title || "(untitled)"),
              (f.document || f.standard) ? el("div", { class: "finding-refs muted" },
                `${f.document ? `Document: ${f.document}` : ""}${f.document && f.standard ? "   ·   " : ""}${f.standard ? `Standard: ${f.standard}` : ""}`) : null,
              f.description ? el("div", { class: "finding-desc" }, f.description) : null,
              f.recommendation ? el("div", { class: "finding-rec" }, [el("strong", {}, "Recommendation: "), f.recommendation]) : null,
            ]));
          }
          body.appendChild(group);
        }
      }
    }
    mount.replaceChildren(el("div", {}, [head, body]));
  }

  // Full API render for a page: editable readiness + documents + uploads.
  async function renderApi(role, readinessMountId) {
    wireTabs($("#tablist"));
    const mount = $(readinessMountId);
    const load = async () => {
      mount.replaceChildren(el("div", { class: "loading" }, "Loading…"));
      let payload;
      try { payload = await API.data(API.getToken(role)); }
      catch (ex) {
        if (/auth/i.test(ex.message)) { API.clearToken(role); location.reload(); return; }
        mount.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`));
        return;
      }
      const steps = stepsFromApi(payload.steps);
      const onStatus = async (step, status, sel) => {
        sel.disabled = true;
        try { await API.setStatus(API.getToken(role), step, status); await load(); }
        catch (ex) { sel.disabled = false; alert(`Couldn't save: ${ex.message}`); }
      };
      const phases = [...new Set(steps.map((s) => s.phase))];
      const saveStep = (existing) => stepEditor(existing, phases, async (fields) => {
        if (existing) await API.updateStep(API.getToken(role), existing.step, fields);
        else await API.addStep(API.getToken(role), fields);
        await load();
      });
      const onDeleteStep = async (s) => {
        if (!confirm(`Delete step #${s.step}: “${(s.action || "").slice(0, 60)}”?`)) return;
        try { await API.deleteStep(API.getToken(role), s.step); await load(); }
        catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
      };
      const tools = el("div", { class: "row-tools" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: load }, "↻ Refresh"),
        role === "rushroom" ? el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => saveStep(null) }, "+ Add step") : null,
        el("button", { class: "btn btn-sm", type: "button", onclick: () => window.print() }, "🖨 Print / Save PDF"),
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `Live · signed in as ${role} · ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        el("div", { class: "notice ok" }, role === "rushroom"
          ? "Signed in as Rushroom — edit any step's status from the dropdowns; changes save instantly."
          : "Signed in as a supplier — update the status of your steps and upload documents; changes save instantly."),
        tools,
        summaryTiles(steps),
        phaseToolbar(),
        phaseOverview(steps),
        blockersPanel(steps),
        el("h2", { class: "visually-hidden" }, "Steps by phase"),
        phaseSections(steps, role === "rushroom"
          ? { editable: true, onStatus, onEditStep: saveStep, onDeleteStep }
          : { editable: true, onStatus }),
      ]);
      mount.replaceChildren(...frag.childNodes);

      const templatesOf = () => (payload.documents || []).filter((d) => (d.kind || "template") === "template" && d.id);
      const onNewVersion = (d) => documentVersionEditor(d, role, load);
      const onDraft = (d) => documentDraftAssistant(d, role, load, { templates: templatesOf() });
      const onCreateOperational = (d) => createOperationalFromTemplate(d, role, load, templatesOf());
      const onCreateNew = () => documentDraftAssistant(null, role, load, { mode: "create", templates: templatesOf() });
      const docsPanel = $("#documents-panel");
      docsPanel.replaceChildren(el("div", {}, [
        role === "supplier" ? uploadCard(role, steps) : manageDocumentsCard(role, load),
        documentLibrary(role === "supplier" ? "supplier" : null, payload.documents, { manage: role === "rushroom", onNewVersion, onDraft, onCreateOperational, onCreateNew }),
      ].filter(Boolean)));
      const review = await uploadsReview(role, load);
      if (review) docsPanel.appendChild(review);
    };
    await load();
    const stdPanel = $("#standards-panel");
    if (stdPanel) renderStandards(role, stdPanel);
    const devPanel = $("#deviations-panel");
    if (devPanel && role === "rushroom") renderDeviations(role, devPanel);
  }

  /* ---------------- expose shared API ---------------- */
  window.Portal = {
    CFG, $, $$, el, portalHash, setupGate, loadSteps, norm,
    summaryTiles, phaseOverview, phaseToolbar, blockersPanel, phaseSections, stepsTable, documentLibrary,
    sourceNotice, wireTabs, statusBadge,
    apiEnabled, setupApiGate, renderApi,
  };

  /* ---------------- full-portal page init ---------------- */
  function initFullPortal() {
    if (apiEnabled()) setupApiGate("rushroom", () => renderApi("rushroom", "#readiness-panel"));
    else setupGate(renderPortal); // read-only fallback
  }

  async function renderPortal() {
    wireTabs($("#tablist"));
    await refreshReadiness();
    $("#documents-panel").replaceChildren(documentLibrary(null));
  }

  async function refreshReadiness() {
    const mount = $("#readiness-panel");
    mount.replaceChildren(el("div", { class: "loading" }, "Loading status…"));
    try {
      const { steps, source } = await loadSteps();
      const tools = el("div", { class: "row-tools" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: refreshReadiness }, "↻ Reload status"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => window.print() }, "🖨 Print / Save PDF"),
        CFG.statusSheetViewUrl ? el("a", { class: "btn btn-sm", href: CFG.statusSheetViewUrl, target: "_blank", rel: "noopener" }, "Open the plan ↗") : null,
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `${source === "live" ? "Live" : "Snapshot"} · loaded ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        sourceNotice(source),
        tools,
        summaryTiles(steps),
        phaseToolbar(),
        phaseOverview(steps),
        blockersPanel(steps),
        el("h2", { class: "visually-hidden" }, "Steps by phase"),
        phaseSections(steps),
      ]);
      mount.replaceChildren(...frag.childNodes);
    } catch (err) {
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load status: ${err.message}. Check the published Sheet URL and sharing.`));
    }
  }

  if (document.body && document.body.dataset.page === "full") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initFullPortal);
    else initFullPortal();
  }
})();
