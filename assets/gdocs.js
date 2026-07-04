/*
 * In-browser Google Docs integration (Google Identity Services).
 * ---------------------------------------------------------------------------
 * On a personal (non-Workspace) Google account a service account cannot create
 * Docs — it has no Drive storage. So instead we sign the Rushroom user in with
 * their OWN Google account (a short-lived access token, kept only in memory)
 * and create/read the Doc in THEIR Drive, straight from the browser.
 *
 * Setup: create an OAuth 2.0 Client ID (type: Web application) in the same
 * Google Cloud project, add the portal origin as an authorised JavaScript
 * origin, and paste the Client ID into config.js -> google.oauthClientId.
 */
(function () {
  const CFG = (window.PORTAL_CONFIG && window.PORTAL_CONFIG.google) || {};
  const CLIENT_ID = CFG.oauthClientId || "";
  // documents: create/read the Doc; drive.file: export the app-created Doc as a file.
  const SCOPES = "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file";
  const MIME = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
  };

  let tokenClient = null;
  let accessToken = "";
  let tokenExpiry = 0;

  const gisReady = () => !!(window.google && google.accounts && google.accounts.oauth2);
  const configured = () => !!CLIENT_ID;

  function ensureClient() {
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: () => {} });
    return tokenClient;
  }

  /* Get an access token. MUST be called from a user gesture the first time so
   * the consent popup isn't blocked. Reuses a cached token until it expires. */
  function getToken() {
    return new Promise((resolve, reject) => {
      if (!configured()) return reject(new Error("Google Docs isn't set up yet — add an OAuth Client ID in config.js (google.oauthClientId)."));
      if (!gisReady()) return reject(new Error("The Google sign-in library hasn't loaded yet. Check your connection and try again."));
      if (accessToken && Date.now() < tokenExpiry - 60000) return resolve(accessToken);
      const client = ensureClient();
      client.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        resolve(accessToken);
      };
      try { client.requestAccessToken({ prompt: accessToken ? "" : "consent" }); }
      catch (e) { reject(e); }
    });
  }

  async function gapi(url, opts = {}) {
    const token = await getToken();
    const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `Google API error (HTTP ${res.status})`);
    return data;
  }

  // Create a Doc in the signed-in user's Drive and insert the draft text.
  async function createDoc(title, text) {
    const doc = await gapi("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      body: JSON.stringify({ title: (title || "Rushroom compliance draft").slice(0, 300) }),
    });
    const documentId = doc.documentId;
    if (text && text.trim()) {
      await gapi(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] }),
      });
    }
    return { documentId, editUrl: `https://docs.google.com/document/d/${documentId}/edit` };
  }

  function extractText(doc) {
    const parts = [];
    for (const el of (doc.body && doc.body.content) || []) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements || []) if (pe.textRun && pe.textRun.content) parts.push(pe.textRun.content);
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          const cells = (row.tableCells || []).map((c) => {
            let t = "";
            for (const cc of c.content || []) if (cc.paragraph) for (const pe of cc.paragraph.elements || []) if (pe.textRun && pe.textRun.content) t += pe.textRun.content;
            return t.trim();
          });
          parts.push(cells.join("\t") + "\n");
        }
      }
    }
    return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function fetchDoc(documentId) {
    const doc = await gapi(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
    return extractText(doc);
  }

  // Export the Doc as a real file (Word .docx or PDF), preserving formatting.
  async function exportDoc(documentId, kind) {
    const mimeType = MIME[kind] || MIME.docx;
    const token = await getToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}/export?mimeType=${encodeURIComponent(mimeType)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (_) {}
      throw new Error(msg);
    }
    return res.blob();
  }

  // Import a file (Word/HTML/text blob) into a NEW editable Google Doc in the
  // user's Drive, converting it. Returns { documentId, editUrl }.
  async function importDoc(blob, name) {
    const token = await getToken();
    const boundary = "gdz" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const meta = JSON.stringify({ name: (name || "Document").slice(0, 300), mimeType: "application/vnd.google-apps.document" });
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`;
    const body = new Blob([head, blob, `\r\n--${boundary}--`], { type: `multipart/related; boundary=${boundary}` });
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
    return { documentId: data.id, editUrl: `https://docs.google.com/document/d/${data.id}/edit` };
  }

  window.PortalGDocs = { configured, gisReady, getToken, createDoc, fetchDoc, exportDoc, importDoc };
})();
