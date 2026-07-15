function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export type AiProvider = "openrouter" | "claude-code";

const aiProvider = ((process.env.AI_PROVIDER as AiProvider | undefined) ?? "openrouter") as AiProvider;

export const config = {
  port: Number(process.env.PORT ?? 8787),
  sharedSecret: required("HEURI_SHARED_SECRET"),
  aiProvider,
  // Only required when aiProvider is "openrouter" — claude-code mode uses a local
  // `claude login` session instead and needs no API key.
  openrouterApiKey: aiProvider === "openrouter" ? required("OPENROUTER_API_KEY") : (process.env.OPENROUTER_API_KEY ?? ""),
  openrouterModel: process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
  // Path/command for the Claude Code CLI binary when aiProvider is "claude-code".
  // Personal/local use only: relies on a `claude login` session on this machine,
  // billed against that account's Pro/Max/Team subscription usage — not meant for
  // a shared, multi-user backend deployment.
  claudeCodeBin: process.env.CLAUDE_CODE_BIN ?? "claude",
  tileTtlMs: Number(process.env.HEURI_TILE_TTL_MS ?? 1000 * 60 * 60 * 6), // 6h
  publicBaseUrl: process.env.HEURI_PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
};
