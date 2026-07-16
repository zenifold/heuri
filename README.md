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

Note: `plugin/package.json` points the `xlsx` (spreadsheet import/export) dependency at
`cdn.sheetjs.com` rather than the npm registry — the npm-published `xlsx` package has known
high-severity vulnerabilities (prototype pollution, ReDoS) with no fix published there; SheetJS's
own CDN carries the actual patched builds. `npm install` picks this up automatically from
`package.json`/`package-lock.json`, nothing extra to do.

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

The first page of every deck is a **cover page** — evaluation name, generation date, a short
methodology blurb, and a legend explaining the four pin/card colors — built automatically the first
time you run Capture screenshots each session, ahead of even the nav/footer captures.

The panel's main flow is five steps — **capture, AI-review, then add your own comments** — with
everything else (page tools, bulk edit, recommendations, logs) tucked into collapsed sections below
so the panel stays focused on that path:

1. **Site** — enter a URL, click **Discover pages** (reads `sitemap.xml` + nav links, suggests up to
   10 candidate pages categorized by type), or paste URLs manually.
2. **Pages** — check/uncheck, edit labels, add more. **Viewports** underneath: Desktop / Mobile,
   plus optional **Global Nav (header)** / **Footer** (captured once, placed as their own pages
   first in the deck).
3. **Capture screenshots** — the slow, Playwright-heavy step. Screenshots land on the canvas as soon
   as each is captured, before any AI analysis, so you see real progress and keep what's done if a
   later step fails.
4. **AI review** — pick which captured pages get analyzed, click **Run AI review**. Rebuilds those
   same Figma frames in place (no duplicates) with numbered pins and color-coded comment cards.
   *Or: import findings from a spreadsheet* (collapsed dropdown) is the manual alternative — export
   a template, fill in Severity / Heuristic / Title / Description in Excel, import it back to get
   the same pin/card format from your own findings instead of the AI's.
5. **Add your own comments** — fill in severity/heuristic/title/description, then drag the colored
   dot onto the exact spot on any screenshot to drop a pin there. Figma plugins have no "click
   anywhere on the canvas" event, but dragging an element from the panel onto the canvas does report
   real drop coordinates — the closest real equivalent, and more precise than a click since you see
   exactly where it'll land before releasing. Renumbers into correct reading order automatically and
   connects to its card with a dashed line. **Undo last comment** if you misplace one.

Below that, collapsed by default:
- **Page tools** — **Renumber pins** / **Refresh Key Fixes** (select a page on canvas first), and
  **Jump to page** (reads the canvas fresh each time, works even after reopening the plugin).
- **Review status & bulk edit** — an **Evaluation** picker (which review to read from — works for
  an older one too, not just the one you just ran), **Refresh review status** for a per-page
  severity breakdown, and canvas-multi-select-driven **Toggle resolved** / **Set assignee** /
  **Set severity** / **Delete selected comment(s)**.
- **Final recommendations** — reads every comment card in the selected evaluation (across AI review,
  spreadsheet import, and manual additions) and asks the AI to synthesize overarching themes and
  prioritized recommendations across the *whole* site. Built as one more page; re-running replaces
  the previous version instead of duplicating.

The panel follows Figma's own light/dark theme automatically — override this in Configuration ->
**Appearance** (Match Figma / Light / Dark) if you want a specific look regardless of the app's
theme. The four severity colors are registered as shared Color Styles (visible in Figma's own
Styles panel) rather than one-off fills — restyle them once, everywhere.

Every pin and comment card is an **instance of a shared Figma component** (one "Severity" variant
each, in a `Heuri Components` page created the first time you run a review — safe to leave alone,
it's the master library everything else is instanced from). Editing a master updates every pin/card
across every page at once; changing a comment's severity (manually via the Figma properties panel,
or through **Set severity for selected**) is a native variant swap rather than a recolored fill.

**Reset plugin** (in Configuration) clears the page list, captured screenshots, and saved session —
keeps your Backend URL/secret. Session state (page list + captures) also persists automatically
across closing/reopening the panel.

The **Log** panel at the bottom (raw technical output, mainly useful for troubleshooting) is
collapsed by default, same as Configuration and the spreadsheet import section above — status
messages after each action still show above it either way.

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
