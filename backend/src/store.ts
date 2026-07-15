import { randomUUID } from "node:crypto";
import { config } from "./config.js";

interface StoredTile {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

// In-memory, short-TTL store for scan output. The backend is intentionally
// stateless across deploys/restarts — this only exists so a plugin panel
// that's closed and reopened within a session can re-fetch tiles without
// re-running Playwright. Swap for S3/R2 if multi-instance scaling is needed.
const tiles = new Map<string, StoredTile>();

export function putTile(buffer: Buffer, contentType: string): string {
  const id = randomUUID();
  tiles.set(id, { buffer, contentType, expiresAt: Date.now() + config.tileTtlMs });
  return id;
}

export function getTile(id: string): StoredTile | undefined {
  const tile = tiles.get(id);
  if (!tile) return undefined;
  if (tile.expiresAt < Date.now()) {
    tiles.delete(id);
    return undefined;
  }
  return tile;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, tile] of tiles) {
    if (tile.expiresAt < now) tiles.delete(id);
  }
}, 60_000).unref();
