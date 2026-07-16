import { z } from "zod";
import { config } from "./config.js";
import { runClaudeCli, stripCodeFence } from "./analyze.js";

const SEVERITIES = ["needs-fix", "improvement", "idea", "good"] as const;

const FindingInputSchema = z.object({
  page: z.string(),
  viewport: z.string(),
  severity: z.enum(SEVERITIES),
  heuristic: z.string(),
  title: z.string(),
  description: z.string(),
});
export type FindingInput = z.infer<typeof FindingInputSchema>;
export { FindingInputSchema };

const RecommendationSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.enum(["high", "medium", "low"]),
});

const SynthesisSchema = z.object({
  summary: z.string(),
  themes: z.array(z.string()),
  recommendations: z.array(RecommendationSchema),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

const SEVERITY_LABELS: Record<(typeof SEVERITIES)[number], string> = {
  "needs-fix": "Needs to be fixed",
  improvement: "Areas of improvement",
  idea: "Idea / Recommendation",
  good: "This is good",
};

function buildSynthesisPrompt(siteLabel: string, findings: FindingInput[]): string {
  const byPage = new Map<string, FindingInput[]>();
  for (const f of findings) {
    const list = byPage.get(f.page) ?? [];
    list.push(f);
    byPage.set(f.page, list);
  }
  const findingsText = [...byPage.entries()]
    .map(
      ([page, items]) =>
        `## ${page}\n${items.map((f) => `- [${SEVERITY_LABELS[f.severity]}] (${f.heuristic}) ${f.title}: ${f.description}`).join("\n")}`
    )
    .join("\n\n");

  return `You are a senior UX strategist writing an executive summary for a full heuristic evaluation of "${siteLabel}". Below is every individual finding from a page-by-page review, grouped by page.

${findingsText}

Based on ALL of these findings TOGETHER — not any single one — produce:
1. summary: a 2-4 sentence overall narrative of the site's UX health, written for a stakeholder who won't read the page-by-page detail.
2. themes: 3-6 overarching themes — patterns that recur across MULTIPLE pages or findings, not a restatement of one individual finding. Each should be something that, if addressed, would improve more than one page at once.
3. recommendations: 3-8 strategic recommendations, each with a title, a 1-3 sentence description, and a priority ("high", "medium", or "low"). Pitch these at a strategic/roadmap level — not micro-fixes already captured in the individual page findings — and prioritize by impact across the whole site.

Return strictly valid JSON matching the provided schema, nothing else.`;
}

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    themes: { type: "array", items: { type: "string" } },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "description", "priority"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "themes", "recommendations"],
  additionalProperties: false,
};

async function synthesizeViaOpenRouterOnce(siteLabel: string, findings: FindingInput[]): Promise<Synthesis> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openrouterModel,
      max_tokens: 2000,
      messages: [{ role: "user", content: buildSynthesisPrompt(siteLabel, findings) }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "site_synthesis", strict: true, schema: RESPONSE_JSON_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = body.choices[0]?.message.content ?? "{}";
  return SynthesisSchema.parse(JSON.parse(raw));
}

async function synthesizeViaOpenRouter(siteLabel: string, findings: FindingInput[]): Promise<Synthesis> {
  try {
    return await synthesizeViaOpenRouterOnce(siteLabel, findings);
  } catch (err) {
    // Same rationale as analyze.ts's per-tile retry: occasional truncated/
    // malformed JSON resolves on one retry; real failures (auth, rate limit)
    // throw a plain Error and aren't retried here.
    if (err instanceof SyntaxError || err instanceof z.ZodError) {
      return await synthesizeViaOpenRouterOnce(siteLabel, findings);
    }
    throw err;
  }
}

// Local/personal use only — same constraints as analyzeTileViaClaudeCode in
// analyze.ts. No file access needed here (pure text synthesis), so no
// --allowedTools grant at all, unlike the per-tile image analysis path.
async function synthesizeViaClaudeCode(siteLabel: string, findings: FindingInput[]): Promise<Synthesis> {
  const prompt = `${buildSynthesisPrompt(siteLabel, findings)}

Respond with ONLY a raw JSON object — no markdown code fences, no commentary, no explanation before or after — matching exactly this shape:
{"summary": string, "themes": string[], "recommendations": [{"title": string, "description": string, "priority": "high"|"medium"|"low"}]}`;

  const { stdout } = await runClaudeCli(["--bare", "-p", prompt, "--output-format", "json"], 120_000);

  const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
  if (envelope.is_error || !envelope.result) {
    throw new Error(`Claude Code CLI error: ${envelope.result ?? stdout.slice(0, 500)}`);
  }
  return SynthesisSchema.parse(JSON.parse(stripCodeFence(envelope.result)));
}

export async function synthesizeFindings(siteLabel: string, findings: FindingInput[]): Promise<Synthesis> {
  return config.aiProvider === "claude-code"
    ? synthesizeViaClaudeCode(siteLabel, findings)
    : synthesizeViaOpenRouter(siteLabel, findings);
}
