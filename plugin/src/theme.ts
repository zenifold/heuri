import type { Severity } from "./types";

export const SEVERITY_LABEL: Record<Severity, string> = {
  "needs-fix": "Needs to be fixed",
  improvement: "Areas of improvement",
  idea: "Idea / Recommendation",
  good: "This is good",
};

export const SEVERITY_COLOR: Record<Severity, { badge: RGB; cardBg: RGB; text: RGB }> = {
  "needs-fix": { badge: { r: 0.878, g: 0.267, b: 0.169 }, cardBg: { r: 0.984, g: 0.878, b: 0.863 }, text: { r: 0.475, g: 0.129, b: 0.075 } },
  improvement: { badge: { r: 0.941, g: 0.706, b: 0.161 }, cardBg: { r: 0.992, g: 0.953, b: 0.851 }, text: { r: 0.475, g: 0.349, b: 0.031 } },
  idea: { badge: { r: 0.557, g: 0.267, b: 0.678 }, cardBg: { r: 0.945, g: 0.890, b: 0.969 }, text: { r: 0.318, g: 0.129, b: 0.412 } },
  good: { badge: { r: 0.153, g: 0.682, b: 0.376 }, cardBg: { r: 0.882, g: 0.969, b: 0.910 }, text: { r: 0.078, g: 0.353, b: 0.196 } },
};

export const HEADER_BAND_COLOR: RGB = { r: 0.894, g: 0.933, b: 0.941 };
export const PAGE_BG_COLOR: RGB = { r: 1, g: 1, b: 1 };
export const BODY_TEXT_COLOR: RGB = { r: 0.129, g: 0.145, b: 0.161 };

export const FONT = { family: "Inter", style: "Regular" };
export const FONT_BOLD = { family: "Inter", style: "Bold" };

export async function loadFonts() {
  await Promise.all([figma.loadFontAsync(FONT), figma.loadFontAsync(FONT_BOLD)]);
}
