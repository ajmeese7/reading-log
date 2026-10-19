# Passkey authentication

The reading list and feeds are public. Use **Add** on the page to sign in with
a passkey and save a URL. Leave the title blank to fetch it automatically, or
enter a title yourself. If lookup fails, the form keeps your URL and asks for a
title. Existing token-based API clients continue to work.

## Setup

1. Install dependencies with Node.js 22.6+:
   ```bash
   npm ci
   ```
2. Sign in to Cloudflare:
   ```bash
   npx wrangler login
   ```
3. Create the authentication database:
   ```bash
   npx wrangler d1 create reading-log-auth
   ```
   Add the returned `database_id` to the existing `[[d1_databases]]` section in
   `wrangler.toml`. Database IDs are public configuration, not secrets. The
   reading entries remain in the existing `READING_KV` namespace.
4. Apply the schema:
   ```bash
   npm run db:migrate
   ```
5. Generate a setup token:
   ```bash
   openssl rand -hex 32
   ```
   Store the generated value through the interactive secret prompt:
   ```bash
   npx wrangler secret put SETUP_TOKEN
   ```
   Paste the generated value at the prompt.
   Keep `READING_TOKEN` as a separate Cloudflare secret for scripts. Neither
   token belongs in `wrangler.toml`, source files, or commits.
6. Check that `AUTH_ORIGIN` in `wrangler.toml` matches the site's exact origin, without a trailing slash.
   Run the checks and deploy:
   ```bash
   npm run check
   npm test
   npm run deploy
   ```
7. Visit the HTTPS site and select **Add**.
   Enter your setup token and select **Create passkey**. After the first registration, the setup token cannot add
   more passkeys. It can be deleted from Cloudflare:
   ```bash
   npx wrangler secret delete SETUP_TOKEN
   ```
   To add a passkey on another device, sign in with an existing passkey.
   A phone can approve through the browser QR flow.
   Select **Add another passkey**. Reading-log uses separate credentials from second-brain and worklog.

Sessions last 30 days and use HttpOnly, Secure, SameSite=Strict cookies.
Sign out removes the server-side session. Challenges expire after five minutes
and can be used once. Authentication POST requests are rate limited to 20 per
minute per client IP at each Cloudflare location. Passkeys, public keys,
challenges, and hashed session tokens live in D1, outside version control.
Passkey private keys stay with your authenticator.

Automatic lookup has an eight-second timeout, a 512 KB page limit, and at most
three redirects. Local hostnames, IP literals, URL credentials, and unusual
ports are not fetched. Such links can still be saved with an explicit title.
Only HTTP and HTTPS entry URLs are accepted.

## Local development

```bash
cp .dev.vars.example .dev.vars
# Set local test tokens in .dev.vars; this file is ignored by Git.
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787`, matching the local `AUTH_ORIGIN` in `.dev.vars`.
Wrangler builds and serves the bundled browser script automatically. Local
passkeys are separate from production passkeys. Do not reuse production tokens
for local tests. `.dev.vars*`, build output, and local Wrangler state are
ignored, apart from `.dev.vars.example`.

Production uses the secrets stored with `wrangler secret put`.
Neither `.dev.vars` nor `.env` is required for production deployment.
Use `.dev.vars` for local development. Do not create a separate `.env` file.

## Recovery

If all passkeys are lost, use your Cloudflare account to recover access.
Delete the rows from `sessions`, `challenges`, and then `credentials` in the authentication database.
Set a new `SETUP_TOKEN` and register a new passkey.
The reading entries remain in KV.
