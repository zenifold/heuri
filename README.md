# Heuri — AI-assisted UX heuristic review for Figma

Scans a client site's key pages, captures full-page desktop + mobile screenshots (plus the global
nav/header and footer as their own dedicated captures), runs an AI first-pass UX heuristic review
against a 12-category evaluation framework, and builds the result as native, editable Figma layers —
numbered pins over each screenshot, aligned to a color-coded column of annotation cards — matching
the format of hand-built heuristic review decks. Designers then review, edit, and approve directly
on the Figma canvas.

Two pieces:
- **`backend/`** — a small Node/TypeScript service that captures screenshots (Playwright) and proxies
  AI analysis calls (OpenRouter, or a local Claude Code CLI session).
- **`plugin/`** — the Figma plugin: the actual UI the whole team uses. No terminal, no curl, just a
  panel inside Figma.

## Quickstart (fresh machine)

Prerequisites: Node.js 20+, the Figma desktop app.

```
git clone https://github.com/zenifold/heuri.git
cd heuri

# Backend
cd backend
npm install
npx playwright install chromium      # one-time, downloads headless Chromium (~300MB)
cp .env.example .env                 # then edit .env — see "AI provider" below
npm run dev                          # starts on http://localhost:8787

# Plugin (separate terminal)
cd ../plugin
npm install
npm run build                        # outputs plugin/dist/code.js + plugin/dist/ui.html
```

Then in the **Figma desktop app**: **Plugins → Development → Import plugin from manifest…** →
select `plugin/manifest.json`. Launch it from **Plugins → Development → Heuri – AI Heuristic Review**.

In the plugin's **Configuration** section (top of the panel): Backend URL defaults to
`http://localhost:8787`; type in the `HEURI_SHARED_SECRET` value from `backend/.env`, click **Save**,
then click **Test AI connection** to confirm the AI provider is actually working before running a
real scan.

## AI provider

Set one of these in `backend/.env`:

**OpenRouter (`AI_PROVIDER=openrouter`, the default)** — works on any machine, no local login needed.
1. Sign up at openrouter.ai and create an API key (no card required).
2. Put it in `OPENROUTER_API_KEY`.
3. `OPENROUTER_MODEL` — the free tier (`google/gemma-4-31b-it:free` etc.) is genuinely $0 but shares
   congested capacity and will rate-limit under load. For actual client work, use a cheap paid model
   instead — `google/gemini-2.5-flash` (~$0.30/1M input tokens; a full 10-page review costs well
   under $1) has worked well in practice.

**Your own Claude Pro/Max/Team subscription (`AI_PROVIDER=claude-code`)** — no OpenRouter account
needed, but **local/personal use only** (see below).
```
npm install -g @anthropic-ai/claude-code   # if not already installed
claude login                                # one-time interactive OAuth login, opens a browser
```
This shells out to the `claude` CLI on whatever machine runs the backend, billed against that
account's subscription usage. It is **not** appropriate for a shared team backend — that would mean
putting one person's personal login on a server everyone hits. For team-wide use, use OpenRouter.

## Using it

The plugin panel walks through this in order:
1. **Site** — enter a URL, click **Discover pages** (reads `sitemap.xml` + nav links, suggests up to
   10 candidate pages categorized by type — services, locations, find-a-provider, etc.), or paste
   URLs manually.
2. **Pages to review** — check/uncheck, edit labels, add more.
3. **Viewports** — Desktop / Mobile, plus optional **Global Nav (header)** / **Footer** captures
   (captured once from the first selected page, placed as their own dedicated pages — first in the
   deck, ahead of content pages).
4. **Capture screenshots** — the slow, Playwright-heavy step. Screenshots get placed on the Figma
   canvas immediately (with page title/URL/Key Fixes header) as soon as they're captured, before any
   AI analysis — so you can see real progress and don't lose anything if a later step fails.
5. **Pages to analyze** — pick which of the captured pages actually get AI analysis (doesn't have to
   be all of them — this step can be re-run on a different subset without re-capturing).
6. **Run AI review** — analyzes the selected pages and rebuilds those same Figma frames in place
   (same position, no duplicates) now with numbered pins and color-coded comment cards, aligned to
   roughly the same height as their pin on the screenshot.
7. **Add your own comment** — click a screenshot on the canvas, fill in severity/title/description,
   adds a new pin + card (drag the pin into exact position afterward — Figma has no native
   click-to-place API).
8. **After editing in Figma** — select a page frame, then **Renumber pins** (cleans up numbering
   gaps after you delete/add cards) or **Refresh Key Fixes** (recomputes the page's Key Fixes summary
   from whatever comments currently exist, after you've edited/removed the AI's originals).

**Reset plugin** (in Configuration) clears the page list, captured screenshots, and saved session —
keeps your Backend URL/secret. Session state (page list + captures) also persists automatically
across closing/reopening the panel.

## Deploying the backend for team-wide use (optional)

Everything above runs entirely on one machine. To give the whole team a shared backend instead of
each person running their own:

Docker image is provided (`backend/Dockerfile`, based on `mcr.microsoft.com/playwright`). Deploy to
Render (or Fly.io) as a Docker web service; set the same env vars as `.env.example`, plus
`HEURI_PUBLIC_BASE_URL` to the deployed public URL. Use `AI_PROVIDER=openrouter` with a paid model
for this — not `claude-code`, which only works for a single local user.

Then update `plugin/manifest.json`'s `networkAccess.allowedDomains` to include the deployed domain
(it's currently set to `https://*.onrender.com` as a placeholder — update if deploying elsewhere),
rebuild the plugin, and have teammates point their Backend URL at the shared deployment instead of
`localhost`.

## Security notes

- `/discover-pages` and `/scan` refuse to fetch/navigate to private, loopback, link-local, or
  cloud-metadata addresses (`backend/src/security.ts`) — protects against the backend being used as
  an SSRF proxy into its own network if the shared secret leaks. Does not defend against DNS
  rebinding (accepted tradeoff for an internal tool with a small, trusted user base).
- `/scan` is capped at 10 pages per request.
- Screenshot tiles live in an in-memory store with a TTL (default 6h) — they do **not** survive a
  backend restart. If you restart the backend mid-review, re-run **Capture screenshots** before
  continuing.
