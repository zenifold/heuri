export type Severity = "needs-fix" | "improvement" | "idea" | "good";

export interface Annotation {
  x_pct: number;
  y_pct: number;
  severity: Severity;
  heuristic: string;
  title: string;
  description: string;
  assignee?: string;
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
  theme?: "auto" | "light" | "dark";
}

export interface CollectedFinding {
  page: string;
  viewport: "desktop" | "mobile";
  severity: Severity;
  heuristic: string;
  title: string;
  description: string;
  resolved: boolean;
  assignee: string;
}

export interface Recommendation {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
}

export interface RecommendationsContent {
  summary: string;
  themes: string[];
  recommendations: Recommendation[];
  counts: Record<Severity, number>;
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
  | { type: "collect-findings"; sectionId?: string }
  | { type: "build-recommendations"; siteLabel: string; content: RecommendationsContent; sectionId?: string }
  | { type: "list-sections" }
  | { type: "list-pages" }
  | { type: "jump-to-page"; id: string }
  | { type: "undo-last-comment" }
  | { type: "bulk-delete-comments" }
  | { type: "bulk-set-severity"; severity: Severity }
  | { type: "toggle-resolved" }
  | { type: "set-assignee"; assignee: string }
  | { type: "log"; message: string };

export type CommandName =
  | "renumber"
  | "refresh-key-fixes"
  | "add-comment"
  | "undo-last-comment"
  | "bulk-delete-comments"
  | "bulk-set-severity"
  | "toggle-resolved"
  | "set-assignee";

export type CodeToUiMessage =
  | { type: "settings"; settings: Settings | null }
  | { type: "session"; session: unknown }
  | { type: "review-started" }
  | { type: "page-built"; label: string; warnings?: string[] }
  | { type: "page-build-error"; label: string; message: string }
  | { type: "build-complete" }
  | { type: "build-error"; message: string }
  | { type: "command-result"; command: CommandName; ok: boolean; message: string }
  | { type: "findings-collected"; findings: CollectedFinding[] }
  | { type: "recommendations-built" }
  | { type: "recommendations-build-error"; message: string }
  | { type: "pages-listed"; pages: { id: string; name: string }[] }
  | { type: "sections-listed"; sections: { id: string; name: string }[] };
