# WIRflow

Fill your Excel submittals in plain English — a preparation-side assistant for construction site engineers.

- **`index.html`** — landing page
- **`tool.html`** — the template tool: upload an `.xlsx` template containing `{{field}}` markers, describe what changed, download a filled, correctly-named copy. Formatting (logos, merged cells, borders, formulas) is never touched.
- **`server.js`** — optional zero-dependency backend that adds **AI Smart Parse** (free-form notes → form fields) via any LLM provider you choose.

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

### API

- `GET /api/health` → `{ok, provider, model}` — the tool uses this to decide whether to show the AI button
- `POST /api/parse` → body `{text, fields: [...], dateFormat}` → `{values: {field: value}}`

The server validates input sizes, rate-limits per IP (20/min default), never exposes the API key to the browser, and blocks path traversal on static files.

## Preparing a template (one-time)

Open your existing Excel form and type a marker like `{{wir_no}}`, `{{date}}`, `{{zone}}` into each cell you edit every time. Save it — that's your master template. The tool detects the markers automatically and replaces only them.
