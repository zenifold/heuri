import express from "express";
import cors from "cors";
import { z } from "zod";
import { config } from "./config.js";
import { requireSharedSecret } from "./auth.js";
import { discoverPages } from "./discover.js";
import { captureFullPage, captureComponent, type Viewport } from "./scan.js";
import { analyzeTile } from "./analyze.js";
import { synthesizeFindings, FindingInputSchema } from "./synthesize.js";
import { getTile } from "./store.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Tile images are served without auth (random UUID URLs, short TTL) so
// OpenRouter's servers and the Figma plugin's <img>/fetch calls can load
// them directly without forwarding the shared secret.
app.get("/tiles/:id", (req, res) => {
  const tile = getTile(req.params.id);
  if (!tile) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", tile.contentType);
  res.send(tile.buffer);
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(requireSharedSecret);

const DiscoverQuerySchema = z.object({ siteUrl: z.string().url() });
app.post("/discover-pages", async (req, res) => {
  try {
    const { siteUrl } = DiscoverQuerySchema.parse(req.body);
    const pages = await discoverPages(siteUrl);
    res.json({ pages });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

const MAX_PAGES_PER_SCAN = 10;

const COMPONENT_LABELS: Record<"header" | "footer", string> = {
  header: "Global Navigation (Header)",
  footer: "Global Navigation (Footer)",
};

const ScanBodySchema = z
  .object({
    pages: z.array(z.object({ url: z.string().url(), label: z.string() })).max(MAX_PAGES_PER_SCAN).default([]),
    viewports: z.array(z.enum(["desktop", "mobile"])).min(1),
    // Captures the site's global nav/header and/or footer as their own
    // dedicated "pages" — sourced from the first entry in `pages`, or from
    // `referenceUrl` when capturing header/footer standalone (no content
    // page in this particular request, e.g. one call per capture job).
    components: z.array(z.enum(["header", "footer"])).optional(),
    referenceUrl: z.string().url().optional(),
  })
  .refine((data) => data.pages.length > 0 || (data.components?.length ?? 0) > 0, {
    message: "Must provide at least one page or component to capture",
  });
app.post("/scan", async (req, res) => {
  let parsed;
  try {
    parsed = ScanBodySchema.parse(req.body);
  } catch (err) {
    res.status(400).json({ error: String(err) });
    return;
  }
  // Each page/viewport capture is isolated: one bad URL or Playwright timeout
  // shouldn't discard screenshots already captured for the rest of the batch.
  const results = [];
  for (const page of parsed.pages) {
    for (const viewport of parsed.viewports as Viewport[]) {
      try {
        const result = await captureFullPage(page.url, viewport);
        results.push({ label: page.label, ...result });
      } catch (err) {
        results.push({ label: page.label, pageUrl: page.url, viewport, tiles: [], error: String(err) });
      }
    }
  }

  const referenceUrl = parsed.pages[0]?.url ?? parsed.referenceUrl;
  for (const kind of parsed.components ?? []) {
    const label = COMPONENT_LABELS[kind];
    for (const viewport of parsed.viewports as Viewport[]) {
      if (!referenceUrl) {
        results.push({ label, pageUrl: "", viewport, tiles: [], error: "No reference URL provided for component capture" });
        continue;
      }
      try {
        const result = await captureComponent(referenceUrl, kind, viewport);
        if (result) {
          results.push({ label, ...result });
        } else {
          results.push({ label, pageUrl: referenceUrl, viewport, tiles: [], error: `No ${kind} element found on the page` });
        }
      } catch (err) {
        results.push({ label, pageUrl: referenceUrl, viewport, tiles: [], error: String(err) });
      }
    }
  }

  res.json({ results });
});

const AnalyzeBodySchema = z.object({
  imageUrl: z.string().url(),
  pageLabel: z.string(),
});
app.post("/analyze", async (req, res) => {
  try {
    const { imageUrl, pageLabel } = AnalyzeBodySchema.parse(req.body);
    const annotations = await analyzeTile({ imageUrl, pageLabel });
    res.json({ annotations });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Exercises the real capture -> analyze path against a fast, always-available
// test page (not the user's actual target site) so the plugin can confirm
// the configured AI provider genuinely works and show real sample output,
// without waiting on a full site scan.
app.post("/test-ai", async (_req, res) => {
  const start = Date.now();
  const model = config.aiProvider === "openrouter" ? config.openrouterModel : undefined;
  try {
    const scanResult = await captureFullPage("https://example.com", "desktop");
    const tile = scanResult.tiles[0];
    if (!tile) throw new Error("Test capture produced no tiles");
    const annotations = await analyzeTile({ imageUrl: tile.url, pageLabel: "AI Connection Test" });
    res.json({
      ok: true,
      provider: config.aiProvider,
      model,
      elapsedMs: Date.now() - start,
      findingCount: annotations.length,
      sample: annotations[0] ?? null,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      provider: config.aiProvider,
      model,
      elapsedMs: Date.now() - start,
      error: String(err),
    });
  }
});

const SynthesizeBodySchema = z.object({
  siteLabel: z.string(),
  // Findings come from the plugin reading back the *current* state of every
  // comment card across the deck, not the original AI/import data — a
  // designer may have edited, deleted, or added findings by the time this
  // runs. Capped well above what a real review would produce as a safety
  // bound on prompt size.
  findings: z.array(FindingInputSchema).min(1).max(300),
});
app.post("/synthesize", async (req, res) => {
  try {
    const { siteLabel, findings } = SynthesizeBodySchema.parse(req.body);
    const result = await synthesizeFindings(siteLabel, findings);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(config.port, () => {
  console.log(`heuri backend listening on :${config.port}`);
});
