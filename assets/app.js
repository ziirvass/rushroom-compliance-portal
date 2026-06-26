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
        el("h3", {}, "Overall readiness"),
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
    const card = el("div", { class: "card phase-overview" }, el("h3", {}, "Progress by phase"));
    const list = el("div", { class: "phase-bars" });
    for (const [phase, items] of byPhase(steps)) {
      const done = items.filter((s) => s.done).length;
      const pct = items.length ? Math.round((done / items.length) * 100) : 0;
      list.appendChild(el("div", { class: "phase-bar" }, [
        el("div", { class: "phase-bar-head" }, [
          el("span", {}, phase),
          el("span", { class: "muted" }, `${done}/${items.length} · ${pct}%`),
        ]),
        el("div", { class: "progress", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": `${phase}: ${pct}% complete` },
          el("span", { style: `width:${pct}%` })),
      ]));
    }
    card.appendChild(list);
    return card;
  }

  function blockersPanel(steps) {
    const open = steps.filter((s) => s.presale && !s.done).sort((a, b) => a.step - b.step);
    const card = el("div", { class: "card" }, el("h3", {}, "Pre-sale blockers"));
    if (!open.length) {
      card.appendChild(el("p", { class: "muted", style: "margin:0" }, "None — every pre-sale step is complete."));
      return card;
    }
    const ul = el("ul", { class: "blockers" });
    for (const s of open) {
      ul.appendChild(el("li", {}, [
        el("span", { class: "step-no" }, `#${s.step}`),
        el("span", {}, [s.action, " "]),
        statusBadge(s),
      ]));
    }
    card.appendChild(ul);
    return card;
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

  function stepsTable(steps, { showAudience = false, editable = false, onStatus = null } = {}) {
    const head = ["#", "Action", "Owner", "Status", "Priority"];
    if (showAudience) head.splice(3, 0, "Audience");
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

  function phaseSections(steps, opts = {}) {
    const frag = el("div");
    for (const [phase, items] of byPhase(steps)) {
      const done = items.filter((s) => s.done).length;
      frag.appendChild(el("section", { class: "phase" }, [
        el("h3", {}, [phase, " ", el("span", { class: "phase-meta" }, `(${done}/${items.length} done)`)]),
        stepsTable(items.sort((a, b) => a.step - b.step), opts),
      ]));
    }
    return frag;
  }

  function documentLibrary(audienceFilter, docsInput) {
    const source = docsInput || CFG.documents || [];
    const docs = source.filter((d) => !audienceFilter || (d.audience || []).includes(audienceFilter));
    const wrap = el("div");
    if (!docs.length) { wrap.appendChild(el("div", { class: "empty" }, "No documents listed yet.")); return wrap; }
    const cats = new Map();
    for (const d of docs) { if (!cats.has(d.category)) cats.set(d.category, []); cats.get(d.category).push(d); }
    for (const [cat, items] of cats) {
      const group = el("div", { class: "doc-group" }, el("h3", {}, cat));
      const grid = el("div", { class: "docs" });
      for (const d of items) {
        grid.appendChild(el("div", { class: "doc" }, [
          el("div", {}, [
            el("div", { class: "name" }, d.name),
            el("div", { class: "audience" }, `For: ${(d.audience || []).join(", ") || "—"}`),
          ]),
          d.url
            ? el("a", { class: "open", href: d.url, target: "_blank", rel: "noopener" }, "Open ↗")
            : el("span", { class: "pending" }, "link pending"),
        ]));
      }
      group.appendChild(grid);
      wrap.appendChild(group);
    }
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
  function uploadCard(role, steps) {
    const file = el("input", { type: "file", class: "up-file", "aria-label": "Choose a file to upload" });
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
    btn.addEventListener("click", async () => {
      const f = file.files && file.files[0];
      if (!f) { status.className = "up-status warn"; status.textContent = "Choose a file first."; return; }
      btn.disabled = true; status.className = "up-status"; status.textContent = "Uploading…";
      try {
        await API.uploadFile(API.getToken(role), f, { step: stepSel.value || null, note: note.value, supplierLabel: who ? who.value : "" });
        status.className = "up-status ok"; status.textContent = `Uploaded “${f.name}”. Thank you.`;
        file.value = ""; note.value = "";
      } catch (ex) {
        status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`;
      } finally { btn.disabled = false; }
    });
    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Upload a document"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" }, role === "supplier"
        ? "Submit your signed declaration, test reports, datasheets, or RoHS/REACH declarations."
        : "Attach a file to the technical file or a specific step."),
      el("div", { class: "upload-fields" }, [file, stepSel, who, note, btn].filter(Boolean)),
      status,
    ]);
  }

  // Rushroom-only: list of supplier uploads with signed download links.
  async function uploadsReview(role) {
    if (role !== "rushroom") return null;
    const wrap = el("div", { class: "card" }, el("h3", {}, "Supplier uploads"));
    try {
      const { uploads } = await API.listUploads(API.getToken(role));
      if (!uploads || !uploads.length) { wrap.appendChild(el("p", { class: "muted", style: "margin:0" }, "No uploads yet.")); return wrap; }
      const list = el("ul", { class: "uploads" });
      for (const u of uploads) {
        list.appendChild(el("li", {}, [
          u.download_url ? el("a", { href: u.download_url, target: "_blank", rel: "noopener" }, u.file_name) : el("span", {}, u.file_name),
          el("span", { class: "muted" }, ` — ${u.supplier_label || u.uploaded_role}${u.step ? ` · step #${u.step}` : ""}${u.note ? ` · ${u.note}` : ""}`),
        ]));
      }
      wrap.appendChild(list);
    } catch (ex) {
      wrap.appendChild(el("p", { class: "error", style: "margin:0" }, `Couldn't load uploads: ${ex.message}`));
    }
    return wrap;
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
      const tools = el("div", { class: "row-tools" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: load }, "↻ Refresh"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => window.print() }, "🖨 Print / Save PDF"),
        CFG.statusSheetViewUrl ? el("a", { class: "btn btn-sm", href: CFG.statusSheetViewUrl, target: "_blank", rel: "noopener" }, "Open the plan ↗") : null,
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `Live · signed in as ${role} · ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        el("div", { class: "notice ok" }, role === "rushroom"
          ? "Signed in as Rushroom — edit any step's status from the dropdowns; changes save instantly."
          : "Signed in as a supplier — update the status of your steps and upload documents; changes save instantly."),
        tools,
        summaryTiles(steps),
        phaseOverview(steps),
        blockersPanel(steps),
        el("h2", { class: "visually-hidden" }, "Steps by phase"),
        phaseSections(steps, { editable: true, onStatus }),
      ]);
      mount.replaceChildren(...frag.childNodes);

      const docsPanel = $("#documents-panel");
      docsPanel.replaceChildren(el("div", {}, [
        uploadCard(role, steps),
        documentLibrary(role === "supplier" ? "supplier" : null, payload.documents),
      ]));
      const review = await uploadsReview(role);
      if (review) docsPanel.appendChild(review);
    };
    await load();
  }

  /* ---------------- expose shared API ---------------- */
  window.Portal = {
    CFG, $, $$, el, portalHash, setupGate, loadSteps, norm,
    summaryTiles, phaseOverview, blockersPanel, phaseSections, stepsTable, documentLibrary,
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
