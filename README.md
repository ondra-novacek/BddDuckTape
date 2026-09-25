# BDD Duck Tape

BDD Duck Tape reads BDD scenarios from Miro sticky notes, creates Xray Tests in Jira, and can request Gemini suggestions. It is deployed as one Cloudflare Worker: Vite builds the React UI into `dist`, while the Worker handles same-origin `/api/*` requests and serves the remaining static assets.

## Local development

Install dependencies, copy the local Worker binding template, and add real credentials:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`wrangler dev` serves both the UI and API. `.dev.vars` is gitignored and read only locally by Wrangler. If you have an existing legacy `.env`, migrate it locally with `mv .env .dev.vars`; Wrangler otherwise falls back to `.env` for compatibility.

```bash
npm test
npm run typecheck
npm run build
```

## Required Worker bindings

Public configuration can be managed as Worker variables:

- `XRAY_BASE_URL` — defaults to `https://xray.cloud.getxray.app`.
- `JIRA_BASE_URL` — Jira Cloud base URL, used for created-Test links and optional fallback lookup.

Runtime credentials belong only in Cloudflare Worker secrets. Set them for the Worker name in `wrangler.jsonc`:

```bash
npx wrangler secret put MIRO_ACCESS_TOKEN
npx wrangler secret put XRAY_CLIENT_ID
npx wrangler secret put XRAY_CLIENT_SECRET
npx wrangler secret put GEMINI_API_KEY
# Optional fallback only when Xray cannot resolve a Test Set issue ID:
npx wrangler secret put JIRA_EMAIL
npx wrangler secret put JIRA_API_TOKEN
```

Create the Xray API key for the dedicated Jira/Xray bot account. Exported Tests are consequently created by that bot. Limit that account to creating Xray Tests only in the intended Jira projects. Jira credentials are optional and are used solely to resolve a Test Set issue ID when Xray's lookup does not find it.

Use a Miro integration or service identity scoped only to the required boards/team. Keep the Gemini key in a dedicated Google project with usage monitoring. Before enabling Gemini for a wider rollout, obtain company approval for sending BDD content to the selected Gemini tier; free-tier data handling may differ from paid usage.

## Deploy

This repository includes a deployment workflow but does not create Cloudflare resources or perform deployment automatically from local development.

1. Create a Cloudflare Worker account and choose the temporary `bdd-duck-tape.<account-subdomain>.workers.dev` URL (adjust the Worker name in `wrangler.jsonc` if required).
2. Configure the Worker variables and secrets above in Cloudflare.
3. Create a least-privilege Cloudflare API token with permission to deploy this Worker. Save it in the GitHub repository as `CLOUDFLARE_API_TOKEN`.
4. Push a reviewed change to `main`. GitHub Actions runs tests, typecheck, and build for pull requests; successful `main` pushes then run `wrangler deploy`.

For a manual deployment after the Worker has been configured:

```bash
npm run build
npm run deploy
```

## Cloudflare Access with Google Workspace

Protect the exact production Worker URL and its preview URLs in Cloudflare Zero Trust before sharing it:

1. Configure Google Workspace as the sole Access identity provider.
2. Create an Access application for the Worker hostname(s), including preview URL coverage.
3. Start with default deny. Add exactly one Allow policy for Google identities whose email ends in the approved company domain.
4. Enable instant authentication so allowed users go directly to Google Workspace login.
5. Verify that an allowed company account reaches the UI and a personal/external Google account is denied before any Worker route runs.

Cloudflare Access is the access boundary. The application deliberately adds no separate sign-in flow, per-user audit log, or Jira comment mutation.
