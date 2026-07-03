/* Rushroom AB — Compliance Portal API client
 * Thin wrapper around the Supabase `portal-api` Edge Function. The function does
 * all auth and authorization; this just sends JSON and stores the session token.
 * Exposes window.PortalAPI. Loaded before app.js.
 */
(() => {
  "use strict";
  const CFG = (window.PORTAL_CONFIG && window.PORTAL_CONFIG.api) || {};
  const URL_ = (CFG.functionUrl || "").replace(/\/+$/, "");
  const tokenKey = (role) => `rushroom_portal_token_${role}`;

  async function call(payload) {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
    return data;
  }

  const API = {
    configured: () => !!URL_,

    getToken: (role) => sessionStorage.getItem(tokenKey(role)) || "",
    clearToken: (role) => sessionStorage.removeItem(tokenKey(role)),

    async login(role, password) {
      const { token } = await call({ action: "login", role, password });
      sessionStorage.setItem(tokenKey(role), token);
      return token;
    },

    data: (token) => call({ action: "data", token }),

    setStatus: (token, step, status, supplierLabel) =>
      call({ action: "setStatus", token, step, status, supplierLabel }),

    // Rushroom-only action-plan management. `fields` carries the step's action
    // text as `actionText` (not `action`, which is the request router field).
    addStep: (token, fields) => call({ action: "addStep", token, ...fields }),
    updateStep: (token, step, fields) => call({ action: "updateStep", token, step, ...fields }),
    deleteStep: (token, step) => call({ action: "deleteStep", token, step }),

    listUploads: (token) => call({ action: "uploads", token }),
    deleteUpload: (token, id) => call({ action: "deleteUpload", token, id }),

    /* Upload a File: ask the function for a signed URL, PUT the bytes straight
     * to storage, then record the metadata. Returns the stored path. */
    async uploadFile(token, file, { step, note, supplierLabel } = {}) {
      const { signedUrl, path } = await call({ action: "uploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "recordUpload", token, step, note, supplierLabel, path, fileName: file.name });
      return path;
    },

    deleteDocument: (token, id) => call({ action: "deleteDocument", token, id }),
    updateDocument: (token, id, fields) => call({ action: "updateDocument", token, id, ...fields }),

    // Standards & Regulations register (with version history)
    standards: (token) => call({ action: "standards", token }),
    addStandard: (token, fields) => call({ action: "addStandard", token, ...fields }),
    deleteStandard: (token, id) => call({ action: "deleteStandard", token, id }),
    deleteStandardVersion: (token, id) => call({ action: "deleteStandardVersion", token, id }),
    // AI deviation monitoring (Rushroom only). The scan can take a while — the
    // browser fetch has no timeout, so it waits for Claude to finish.
    deviations: (token) => call({ action: "deviations", token }),
    runDeviationScan: (token) => call({ action: "runDeviationScan", token }),

    async uploadStandardVersion(token, file, { standardId, version, effectiveDate, notes } = {}) {
      const { signedUrl, path } = await call({ action: "stdUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addStandardVersion", token, standardId, version, effectiveDate, notes, path, fileName: file.name });
      return path;
    },

    // Upload the standard file WITHOUT registering it yet (for AI auto-fill + human approval).
    async uploadStandardFile(token, file) {
      const { signedUrl, path } = await call({ action: "stdUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      return { path, fileName: file.name };
    },
    // AI reads an already-uploaded standard file and proposes its catalogue fields.
    suggestStandardMetadata: (token, { path, fileName }) => call({ action: "suggestStandardMetadata", token, path, fileName }),
    // Record a version row for an already-uploaded file (used after AI auto-fill approval).
    addStandardVersionRecord: (token, { standardId, version, effectiveDate, notes, path, fileName }) =>
      call({ action: "addStandardVersion", token, standardId, version, effectiveDate, notes, path, fileName }),

    /* ---- Generic upload + AI auto-fill (used by every file-upload flow) ----
     * uploadAnyFile sends the bytes to the right bucket WITHOUT registering the
     * file; suggestFileMetadata then has the AI read it and propose fields; a
     * flow-specific record* call registers it after the human approves. */
    // Ask for a signed upload URL for the right bucket (the PUT is done by the
    // caller, e.g. via XHR so upload progress can be shown).
    signedUploadUrl: (token, fileName, bucket = "documents") =>
      call({ action: bucket === "standards" ? "stdUploadUrl" : bucket === "uploads" ? "uploadUrl" : "docUploadUrl", token, fileName }),
    async uploadAnyFile(token, file, bucket = "documents") {
      const uploadAction = bucket === "standards" ? "stdUploadUrl" : bucket === "uploads" ? "uploadUrl" : "docUploadUrl";
      const { signedUrl, path } = await call({ action: uploadAction, token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      return { path, fileName: file.name };
    },
    suggestFileMetadata: (token, { path, fileName, bucket = "documents" }) =>
      call({ action: "suggestFileMetadata", token, path, fileName, bucket }),
    // Register an already-uploaded library document (after AI auto-fill approval).
    addDocumentRecord: (token, { category, name, audience, kind, path, fileName, version }) =>
      call({ action: "addDocument", token, category, name, audience, kind, storagePath: path, fileName, version }),
    // Add a version row to an existing document for an already-uploaded file.
    addDocumentVersionRecord: (token, { documentId, version, notes, path, fileName }) =>
      call({ action: "addDocumentVersion", token, documentId, version, notes, path, fileName }),
    // Register an already-uploaded supplier/technical-file upload.
    recordUploadRecord: (token, { step, note, supplierLabel, path, fileName }) =>
      call({ action: "recordUpload", token, step, note, supplierLabel, path, fileName }),

    // Google Docs round-trip for AI drafts: create a shared Doc from the draft
    // text, then fetch the edited content back before publishing.
    createGoogleDoc: (token, { draftText, documentName }) =>
      call({ action: "createGoogleDoc", token, draftText, documentName }),
    fetchGoogleDocContent: (token, { googleDocId }) =>
      call({ action: "fetchGoogleDocContent", token, googleDocId }),

    /* Add a library document: upload the file to the documents bucket, then
     * register it in the documents table. Rushroom only (enforced server-side). */
    async uploadDocument(token, file, { category, name, audience, kind } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addDocument", token, category, name: name || file.name, audience, kind, storagePath: path, fileName: file.name });
      return path;
    },

    // Upload a new version of an existing document (previous versions kept).
    async uploadDocumentVersion(token, file, { documentId, version, notes } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addDocumentVersion", token, documentId, version, notes, path, fileName: file.name });
      return path;
    },

    createOperationalDocumentFromTemplate(token, { templateDocumentId, name, version, notes } = {}) {
      return call({ action: "createOperationalDocumentFromTemplate", token, templateDocumentId, name, version, notes });
    },

    suggestDocumentVersion(token, { documentId, templateDocumentId, notes, preferredVersion, sourceStandardIds = [] } = {}) {
      return call({ action: "suggestDocumentVersion", token, documentId, templateDocumentId, notes, preferredVersion, sourceStandardIds });
    },

    async publishDocumentDraft(token, { documentId, newDocumentName, templateDocumentId, category, audience, version, notes, draftText, fileName, approvedChanges } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: fileName || "draft.md" });
      const body = new Blob([draftText || ""], { type: "text/markdown;charset=utf-8" });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": "text/markdown;charset=utf-8" }, body });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "publishDocumentDraft", token, documentId, newDocumentName, templateDocumentId, category, audience, version, notes, draftText, fileName, approvedChanges, path });
      return path;
    },
  };

  window.PortalAPI = API;
})();
