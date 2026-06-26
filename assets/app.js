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

  /* ---------------- status model ---------------- */
  const STATUS = {
    done: { label: "Done", cls: "s-done" },
    "in progress": { label: "In progress", cls: "s-progress" },
    blocked: { label: "Blocked", cls: "s-blocked" },
    "not started": { label: "Not started", cls: "s-todo" },
  };
  const norm = (s) => (s || "").trim().toLowerCase();
  function statusInfo(s) { return STATUS[norm(s)] || { label: s || "Not started", cls: "s-todo" }; }
  const isTrue = (v) => /^(true|yes|y|1)$/i.test(String(v || "").trim());
  const audienceList = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

  function normalizeStep(r) {
    return {
      step: Number(r.step) || 0,
      phase: r.phase || "Unphased",
      action: r.action || "",
      status: statusInfo(r.status).label,
      cls: statusInfo(r.status).cls,
      done: norm(r.status) === "done",
      owner: r.owner || "",
      presale: isTrue(r.presale),
      audience: audienceList(r.audience),
      doc: r.doc || "",
      notes: r.notes || "",
    };
  }

  async function loadSteps() {
    if (CFG.statusSheetCsvUrl) {
      const res = await fetch(CFG.statusSheetCsvUrl, { cache: "no-cache" });
      if (!res.ok) throw new Error(`Sheet returned HTTP ${res.status}`);
      return { steps: parseCSV(await res.text()).map(normalizeStep), source: "live" };
    }
    return { steps: (CFG.sampleSteps || []).map(normalizeStep), source: "sample" };
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
        el("div", { class: "progress" }, el("span", { style: `width:${pct}%` })),
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

  function stepsTable(steps, { showAudience = false } = {}) {
    const head = ["#", "Action", "Owner", "Status", ""];
    if (showAudience) head.splice(3, 0, "Audience");
    const tbody = el("tbody");
    for (const s of steps) {
      const cells = [
        el("td", { class: "step-no-cell" }, String(s.step)),
        el("td", {}, [
          s.action,
          s.doc ? el("span", {}, [" ", el("a", { href: s.doc, target: "_blank", rel: "noopener" }, "doc ↗")]) : null,
        ]),
        el("td", {}, s.owner || "—"),
      ];
      if (showAudience) cells.push(el("td", { class: "muted" }, s.audience.join(", ") || "—"));
      cells.push(el("td", {}, statusBadge(s)));
      cells.push(el("td", {}, s.presale ? el("span", { class: "pill-presale" }, "pre-sale") : null));
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

  function documentLibrary(audienceFilter) {
    const docs = (CFG.documents || []).filter((d) => !audienceFilter || (d.audience || []).includes(audienceFilter));
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
    return el("div", { class: "notice" },
      "Showing bundled sample data. Connect the action-plan Google Sheet in assets/config.js (statusSheetCsvUrl) to read live status.");
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

  /* ---------------- expose shared API ---------------- */
  window.Portal = {
    CFG, $, $$, el, portalHash, setupGate, loadSteps, norm,
    summaryTiles, blockersPanel, phaseSections, stepsTable, documentLibrary,
    sourceNotice, wireTabs, statusBadge,
  };

  /* ---------------- full-portal page init ---------------- */
  function initFullPortal() {
    setupGate(renderPortal);
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
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `${source === "live" ? "Live" : "Sample"} · loaded ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        sourceNotice(source),
        tools,
        summaryTiles(steps),
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
