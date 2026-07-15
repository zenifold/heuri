import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { getTile } from "./store.js";
import { assertPublicHttpUrl } from "./security.js";

export const SEVERITIES = ["needs-fix", "improvement", "idea", "good"] as const;
export type Severity = (typeof SEVERITIES)[number];

const AnnotationSchema = z.object({
  x_pct: z.number().min(0).max(100),
  y_pct: z.number().min(0).max(100),
  severity: z.enum(SEVERITIES),
  heuristic: z.string(),
  title: z.string(),
  description: z.string(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

const AnalyzeResponseSchema = z.object({ annotations: z.array(AnnotationSchema) });

// Modea's internal heuristic evaluation framework (from their spreadsheet
// template) — a superset of Nielsen's 10 that adds Information Architecture,
// Accessibility, Mobile Friendliness, Scanability, and Ability to Transact.
// Each category pairs with a concrete sub-criterion so the model grounds
// findings in a specific, checkable thing rather than a vague heuristic name.
const HEURISTIC_CATEGORIES = [
  { name: "Information Architecture", detail: "Page Hierarchy / Site Structure" },
  { name: "Accessibility", detail: "Color Contrast / Font" },
  { name: "Mobile Friendliness", detail: "Different Screen Sizes" },
  { name: "Scanability", detail: "Find info fast" },
  { name: "Ability to Transact", detail: "Calls to Action" },
  { name: "Visibility of System Status", detail: "Keeps Users Informed" },
  { name: "Match Between System and Real World", detail: "Speak User Language" },
  { name: "User Control and Freedom", detail: "Leave unwanted states" },
  { name: "Consistency and Standards", detail: "Consistent Language and Actions" },
  { name: "Error Prevention", detail: "Eliminate errors" },
  { name: "Aesthetic and Minimalist Design", detail: "No Extra Information" },
  { name: "Help and Documentation", detail: "Explain more difficult tasks" },
];

function buildReviewInstructions(pageLabel: string): string {
  return `You are a senior UX researcher performing a heuristic evaluation of a healthcare website screenshot, using this evaluation framework:
${HEURISTIC_CATEGORIES.map((h, i) => `${i + 1}. ${h.name} — ${h.detail}`).join("\n")}

You are reviewing a segment of "${pageLabel}". This may be a full page, or a dedicated capture of just the site's global navigation header or footer — evaluate whatever is visible in THIS image on its own terms. Identify concrete, specific issues and notable strengths visible in THIS image only.

For each finding, return an annotation with:
- x_pct, y_pct: the point on the image the finding refers to, as a percentage (0-100) of image width/height from the top-left.
- severity: see the strict decision rule below — this is the most common mistake, read it carefully.
- heuristic: which of the 12 categories above applies (use the exact category name, e.g. "Scanability").
- title: a short (<8 word) label.
- description: 1-3 sentences explaining the finding, written the way a UX reviewer would annotate a design deck for a designer to read. Ground it in the category's sub-criterion where relevant.

SEVERITY — choose exactly one, using this decision order:
1. "needs-fix" — something is broken, confusing, inaccessible, or will cause real user friction. There is a genuine problem here.
2. "improvement" — the element currently works and has no real problem, but you can state a SPECIFIC, concrete change that would make it meaningfully better. You must be able to finish the sentence "this would be better if it changed to ___" — if you can't, this is not "improvement."
3. "idea" — a forward-looking, optional suggestion unrelated to any current problem — a "you could also consider ___ for the future," not a fix.
4. "good" — the element is already well executed — a genuine strength worth highlighting to the designer.

STRICT RULE: severity must reflect whether the designer needs to change something, not just whether you have something to say about it.
- If your description does not identify a concrete change the designer should make, it CANNOT be "needs-fix" or "improvement" — it must be "good" (if it's worth praising) or left out entirely (if it's neutral and not noteworthy).
- Never tag a positive observation, a working element, or something with no actual problem as "improvement" — that severity is reserved exclusively for things that have an identifiable, describable way to get better. Mislabeling a strength as "improvement" is the single most common mistake reviewers make with this framework; do not make it.
- Before finalizing each finding, ask yourself: "Am I asking the designer to change something?" Yes → needs-fix or improvement. No → good or idea.

Only flag things actually visible in the image. Prefer 3-8 high-quality findings over exhaustive nitpicking.`;
}

function extractTileId(imageUrl: string): string | null {
  try {
    const match = new URL(imageUrl).pathname.match(/^\/tiles\/([\w-]+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function resolveImageBytes(imageUrl: string): Promise<Buffer> {
  const tileId = extractTileId(imageUrl);
  if (tileId) {
    const tile = getTile(tileId);
    if (!tile) throw new Error(`Tile ${tileId} not found or expired`);
    return tile.buffer;
  }
  // Only reached for non-tile URLs (e.g. an external image URL passed directly to
  // /analyze) — our own tile URLs skip this and read from the in-memory store above.
  await assertPublicHttpUrl(imageUrl);
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function analyzeTileViaOpenRouter(imageUrl: string, pageLabel: string): Promise<Annotation[]> {
  try {
    return await analyzeTileViaOpenRouterOnce(imageUrl, pageLabel);
  } catch (err) {
    // Occasional truncated/malformed JSON from the model (invalid JSON, or
    // valid JSON that doesn't match the schema) — one retry resolves this in
    // practice. Real failures (auth, rate limits, network) throw a plain
    // Error from the fetch/status checks below and aren't retried here.
    if (err instanceof SyntaxError || err instanceof z.ZodError) {
      return await analyzeTileViaOpenRouterOnce(imageUrl, pageLabel);
    }
    throw err;
  }
}

async function analyzeTileViaOpenRouterOnce(imageUrl: string, pageLabel: string): Promise<Annotation[]> {
  // Send image bytes inline as a data URI rather than a fetchable URL —
  // OpenRouter's servers can't reach a localhost backend during local/dev
  // use, and this works identically once deployed, so there's no reason to
  // rely on remote fetch at all.
  const bytes = await resolveImageBytes(imageUrl);
  const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openrouterModel,
      max_tokens: 4000,
      messages: [
        { role: "system", content: buildReviewInstructions(pageLabel) },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUri } },
            { type: "text", text: "Evaluate this screenshot segment." },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "heuristic_annotations",
          strict: true,
          schema: {
            type: "object",
            properties: {
              annotations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    x_pct: { type: "number" },
                    y_pct: { type: "number" },
                    severity: { type: "string", enum: SEVERITIES },
                    heuristic: { type: "string" },
                    title: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["x_pct", "y_pct", "severity", "heuristic", "title", "description"],
                  additionalProperties: false,
                },
              },
            },
            required: ["annotations"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = body.choices[0]?.message.content ?? "{}";
  return AnalyzeResponseSchema.parse(JSON.parse(raw)).annotations;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

// Runs the CLI via spawn (not execFile) so we get stdout back on BOTH success and
// non-zero exit — Claude Code exits 1 on things like "not logged in" or refusals,
// and the useful message lives in the JSON envelope's `result` field, not stderr.
function runClaudeCli(args: string[], timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeCodeBin, args, { windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `Claude Code CLI ("${config.claudeCodeBin}") not found on PATH. Install it and run \`claude login\`, or set AI_PROVIDER=openrouter.`
          )
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
    child.stdin.end();
  });
}

// Local/personal use only: shells out to a `claude login`-authenticated Claude Code
// CLI session on this machine, billed against that account's Pro/Max/Team subscription
// usage instead of a separate API key. Not suitable for the shared team deployment —
// each request would need that operator's personal session on the server. Each
// invocation costs several seconds of CLI startup overhead (observed ~5s), separate
// from model inference time.
async function analyzeTileViaClaudeCode(imageUrl: string, pageLabel: string): Promise<Annotation[]> {
  const bytes = await resolveImageBytes(imageUrl);
  const dir = await mkdtemp(join(tmpdir(), "heuri-tile-"));
  const imagePath = join(dir, "tile.png");
  try {
    await writeFile(imagePath, bytes);

    const prompt = `${buildReviewInstructions(pageLabel)}

Read the image at this exact local file path: ${imagePath}

Respond with ONLY a raw JSON object — no markdown code fences, no commentary, no explanation before or after — matching exactly this shape:
{"annotations": [{"x_pct": number, "y_pct": number, "severity": "needs-fix"|"improvement"|"idea"|"good", "heuristic": string, "title": string, "description": string}]}`;

    const { stdout } = await runClaudeCli(
      ["--bare", "-p", prompt, "--allowedTools", "Read", "--output-format", "json"],
      120_000
    );

    const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (envelope.is_error || !envelope.result) {
      throw new Error(`Claude Code CLI error: ${envelope.result ?? stdout.slice(0, 500)}`);
    }
    return AnalyzeResponseSchema.parse(JSON.parse(stripCodeFence(envelope.result))).annotations;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function analyzeTile(params: { imageUrl: string; pageLabel: string }): Promise<Annotation[]> {
  const { imageUrl, pageLabel } = params;
  return config.aiProvider === "claude-code"
    ? analyzeTileViaClaudeCode(imageUrl, pageLabel)
    : analyzeTileViaOpenRouter(imageUrl, pageLabel);
}
