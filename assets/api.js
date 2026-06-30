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

    /* Add a library document: upload the file to the documents bucket, then
     * register it in the documents table. Rushroom only (enforced server-side). */
    async uploadDocument(token, file, { category, name, audience } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addDocument", token, category, name: name || file.name, audience, storagePath: path });
      return path;
    },
  };

  window.PortalAPI = API;
})();
