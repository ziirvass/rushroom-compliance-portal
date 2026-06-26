# Turning on in-portal login, editing & uploads (Supabase)

By default the portal is read-only (shared password + live Google Sheet). Follow
this once to enable **two-role login, in-portal status editing, and supplier
uploads**. It's free on Supabase's free tier and takes ~10 minutes.

When it's done: Rushroom logs in with one password and can edit every step; a
supplier logs in with a different password and can edit only their steps and
upload files. The portal keeps working in read-only mode until you finish.

---

## 1. Create a Supabase project
1. Sign up at <https://supabase.com> → **New project**.
2. Pick a name, a strong database password (you won't need it again here), and a
   region near you. Wait for it to finish provisioning.

## 2. Create the tables + seed data
1. Left sidebar → **SQL Editor** → **New query**.
2. Open [`supabase/schema.sql`](supabase/schema.sql) from this repo, copy the
   whole file, paste it in, and click **Run**.
   - This creates the `steps`, `documents`, and `uploads` tables (seeded with the
     current 30-step plan and the document links), locks them with Row-Level
     Security, and creates a private `supplier-uploads` storage bucket.

## 3. Choose the two passwords and hash them
The function stores only the **SHA-256 hash** of each password, never the password.
Compute the two hashes (replace the example passwords):

```bash
printf '%s' 'RUSHROOM-PASSWORD-HERE' | shasum -a 256   # macOS  (Linux: sha256sum)
printf '%s' 'SUPPLIER-PASSWORD-HERE' | shasum -a 256
```

Copy the 64-character hex string from each line. Also invent one long random
string for `TOKEN_SECRET` (e.g. from `openssl rand -hex 32`).

## 4. Deploy the Edge Function
Install the CLI and deploy (the function is in `supabase/functions/portal-api`):

```bash
# one-time
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>      # ref is in your project URL

# set the secrets (paste the hashes from step 3)
supabase secrets set \
  RUSHROOM_PW_HASH=<rushroom-hash> \
  SUPPLIER_PW_HASH=<supplier-hash> \
  TOKEN_SECRET=<your-random-string>

# deploy WITH jwt verification off — the function does its own auth
supabase functions deploy portal-api --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function
automatically — you do **not** set those.

> No terminal? You can also create the function and set secrets in the dashboard
> under **Edge Functions** (paste the contents of `index.ts`) and **Edge
> Functions → Manage secrets**.

## 5. Point the portal at the function
1. Copy your function URL — it looks like
   `https://<project-ref>.functions.supabase.co/portal-api`.
2. In [`assets/config.js`](assets/config.js), set:

   ```js
   api: {
     functionUrl: "https://<project-ref>.functions.supabase.co/portal-api",
   },
   ```
3. Commit and push. GitHub Pages redeploys; the portal now shows a **login** that
   accepts the role passwords, with editable status dropdowns and uploads.

---

## How roles are enforced
- The browser only ever calls `portal-api`. The database and storage deny all
  direct access (RLS, private bucket).
- `login` checks the password hash for the role and returns a signed, 8-hour
  session token. Every later request carries that token.
- `setStatus` lets Rushroom edit any step; a supplier may edit only steps whose
  `audience` includes `supplier`. The check runs in the function, server-side.
- `data` returns all steps/documents to Rushroom, but only supplier-tagged ones
  to suppliers — internal rows never reach a supplier's browser.
- Uploads go straight to the private bucket via a short-lived signed URL; only
  Rushroom can list them (with signed download links).

## Changing a password later
Recompute the hash (step 3) and re-set the secret:
```bash
supabase secrets set RUSHROOM_PW_HASH=<new-hash>
```
No redeploy needed for a secret change; existing sessions stay valid until they
expire (8 h) — bump `TOKEN_SECRET` too if you need to force everyone out.

## Security notes
- This is **shared-password-per-role**, which is a pragmatic step up from the
  static gate (auth is now server-side, documents/edits are access-controlled).
  It is not per-user identity. If you later need per-supplier accounts and an
  audit trail of *who* changed what, move to Supabase Auth with one login per
  supplier — the data model already records `updated_by`.
- Keep the `SUPABASE_SERVICE_ROLE_KEY` secret. It lives only in the function's
  environment, never in this repo or the browser.
