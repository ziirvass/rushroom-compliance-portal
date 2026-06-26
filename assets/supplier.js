/* Rushroom AB — Compliance Portal (supplier view)
 * Slimmed page: only supplier-relevant documents and supplier step statuses.
 * Reuses shared helpers from window.Portal (app.js). Nothing internal is shown.
 */
(() => {
  "use strict";
  if (!document.body || document.body.dataset.page !== "supplier") return;

  const P = window.Portal;
  if (!P) { console.error("supplier.js requires app.js (window.Portal) to load first"); return; }
  const { el, setupGate, loadSteps, summaryTiles, phaseSections, documentLibrary, sourceNotice } = P;

  const init = () => setupGate(render);

  async function render() {
    P.wireTabs(P.$("#tablist"));
    await refreshSteps();
    P.$("#documents-panel").replaceChildren(documentLibrary("supplier"));
  }

  async function refreshSteps() {
    const mount = P.$("#steps-panel");
    mount.replaceChildren(el("div", { class: "loading" }, "Loading status…"));
    try {
      const { steps, source } = await loadSteps();
      const supplierSteps = steps.filter((s) => s.audience.includes("supplier"));
      if (!supplierSteps.length) {
        mount.replaceChildren(el("div", { class: "empty" }, "No supplier steps are defined yet."));
        return;
      }
      const tools = el("div", { class: "row-tools" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: refreshSteps }, "↻ Reload status"),
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `${source === "live" ? "Live" : "Sample"} · loaded ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        sourceNotice(source),
        tools,
        summaryTiles(supplierSteps),
        phaseSections(supplierSteps),
      ]);
      mount.replaceChildren(...frag.childNodes);
    } catch (err) {
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load status: ${err.message}.`));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
