# WIRflow

Construction QA automation for site engineers — WIRs, lab tests, NCRs, matrices, and handover packs, per the WIR System Blueprint (15 modules, 13+ DB tables).

- **`app/`** — the full WIR Automation System (SPA, served at `/app/`)
- **`api.js` + `db.js`** — REST API with all module business rules; SQLite via `node:sqlite` (still zero npm dependencies)
- **`index.html`** — landing page
- **`tool.html`** — the Excel template tool: upload an `.xlsx` template containing `{{field}}` markers, describe what changed, download a filled, correctly-named copy
- **`server.js`** — zero-dependency server: static site + app API + optional **AI Smart Parse** via any LLM provider

## The App (blueprint modules M01–M15)

Run `npm start` and open `http://localhost:3000/app/`. Demo logins (password `demo123`):
`engineer@wirflow.app` · `qa@wirflow.app` · `admin@wirflow.app` · `doc@wirflow.app` — seeded with a demo project (Marina Heights Tower).

| Module | Where | Highlights |
|---|---|---|
| M01 Auth & Project Hub | Login, project selector, Team | Roles: Engineer / QA / DocControl / Admin |
| M02 Shop Drawing Registry | Drawings | Upload PDF; same number → new rev, old auto-superseded |
| M03 WIR Form Engine | + New WIR | Auto WIR#, zone→drawing auto-suggest, checklist, TR auto-spawn |
| M04 WIR Status Tracker | WIRs | Draft→Submitted→Under Review→Approved/Rejected; approval blocked by pending/failed TRs, open NCRs, FDT deficits |
| M05 Test Request Generator | Test Requests | Auto TR#; concrete cubes get 7/28-day due dates |
| M06 Lab Results Desk | Results Desk | Built-in spec table (C25/C30/C40, FDT 95% MDD, steel 500MPa, slump ±25mm); instant PASS/FAIL; **FAIL auto-raises NCR** |
| M07 FDT Logger | FDT Tracker | Required = ⌈area/250m²⌉ per layer; deficits block Backfill WIR approval |
| M08 IR Matrix | IR Matrix | Zone × Activity grid, status chips, progress per zone |
| M09 Lab Test Matrix | Lab Matrix | WIR × test-type heat map with pass-rate summary |
| M10 Method Statements | Method Statements | Approval gate: no approved MS → WIR submission blocked |
| M11 Notification Engine | 🔔 bell | WIR submitted/approved, test failed, TR due/overdue, NCR raised, programme lookahead |
| M12 Handover Pack Builder | Handover Pack | Scope filters → indexed printable pack (cover, TOC, 4 sections) |
| M13 Zone Mapper | Zones | Zone↔drawing mapping feeds the WIR form |
| M14 Master Programme | Programme | Activities + planned dates; "WIR Due Soon/Overdue" flags |
| M15 NCR Module | NCRs | Auto-raised on test failure; close requires evidence + QA sign-off; closed NCR + passing retest unblocks approval |

Data lives in `data/wirflow.db` (SQLite) + `data/uploads/` — set `DATA_DIR` to relocate. Delete the folder to reset to seed data.

## Running without a backend

The site is fully static. Host `index.html` + `tool.html` anywhere (GitHub Pages, Netlify, a shared folder). The tool works offline in the browser with the built-in rule-based parser (`field: value`, `zone Z-02`, `date today`, fuzzy field matching). The AI button simply stays hidden.

## Running with the AI backend

Requires Node 18+. No `npm install` needed — there are zero dependencies.

```sh
cp .env.example .env        # pick a provider block, paste your API key
export $(grep -v '^#' .env | grep -v '^$' | xargs)
npm start                   # serves the site + /api/parse on :3000
```

### Choosing an LLM provider

The backend speaks the **OpenAI-compatible chat-completions format** (`LLM_PROVIDER=openai`), which nearly every provider exposes — so switching to whichever is cheapest is just editing three env vars:

| Provider | `LLM_BASE_URL` | Example model |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

Anthropic uses its own wire format — set `LLM_PROVIDER=anthropic` with `LLM_MODEL=claude-haiku-4-5` ($1/$5 per MTok).

Each parse is ~500 tokens, so cost per WIR is a fraction of a cent on any of these.

### Deploying

**Render (one click, free tier):** dashboard → *New → Blueprint* → select this repo. `render.yaml` sets everything up (Groq defaults); you'll be prompted for `LLM_API_KEY`. Or use the deploy link:

```
https://render.com/deploy?repo=https://github.com/devan-prabu/upin24
```

**Railway:** *New Project → Deploy from GitHub repo* → select this repo. `railway.json` configures the start command and health check; add `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` under *Variables*.

**Docker (any host):**

```sh
docker build -t wirflow .
docker run -p 3000:3000 \
  -e LLM_PROVIDER=openai \
  -e LLM_BASE_URL=https://api.groq.com/openai/v1 \
  -e LLM_MODEL=llama-3.3-70b-versatile \
  -e LLM_API_KEY=gsk_... \
  wirflow
```

All three run fine **without** `LLM_API_KEY` too — the site works and the AI button hides itself.

### API

- `GET /api/health` → `{ok, provider, model}` — the tool uses this to decide whether to show the AI button
- `POST /api/parse` → body `{text, fields: [...], dateFormat}` → `{values: {field: value}}`

The server validates input sizes, rate-limits per IP (20/min default), never exposes the API key to the browser, and blocks path traversal on static files.

## Preparing a template (one-time)

Open your existing Excel form and type a marker like `{{wir_no}}`, `{{date}}`, `{{zone}}` into each cell you edit every time. Save it — that's your master template. The tool detects the markers automatically and replaces only them.

## Zero-server demo (`demo.html`)

`demo.html` is the entire app compiled into one file with the database running **in the browser** (localStorage). Host it anywhere static — GitHub Pages, Netlify — or just open it. Same rules, same seed data; "Reset demo data" in the banner restores the seed. Real multi-user deployments should use the Node server instead.
