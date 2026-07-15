export type Severity = "needs-fix" | "improvement" | "idea" | "good";

export interface Annotation {
  x_pct: number;
  y_pct: number;
  severity: Severity;
  heuristic: string;
  title: string;
  description: string;
}

export interface TileWithAnnotations {
  imageBytes: Uint8Array;
  width: number;
  height: number;
  annotations: Annotation[];
}

export interface ViewportSection {
  tiles: TileWithAnnotations[];
}

export interface PageResult {
  label: string;
  url: string;
  desktop: ViewportSection | null;
  mobile: ViewportSection | null;
}

export interface Settings {
  backendUrl: string;
  sharedSecret: string;
}

export type UiToCodeMessage =
  | { type: "load-settings" }
  | { type: "save-settings"; settings: Settings }
  | { type: "load-session" }
  | { type: "save-session"; session: unknown }
  | { type: "start-review"; siteLabel: string }
  | { type: "build-page"; page: PageResult }
  | { type: "finish-review" }
  | { type: "renumber" }
  | { type: "refresh-key-fixes" }
  | { type: "add-comment"; severity: Severity; heuristic: string; title: string; description: string }
  | { type: "log"; message: string };

export type CodeToUiMessage =
  | { type: "settings"; settings: Settings | null }
  | { type: "session"; session: unknown }
  | { type: "review-started" }
  | { type: "page-built"; label: string; warnings?: string[] }
  | { type: "page-build-error"; label: string; message: string }
  | { type: "build-complete" }
  | { type: "build-error"; message: string }
  | { type: "command-result"; command: "renumber" | "refresh-key-fixes" | "add-comment"; ok: boolean; message: string };
