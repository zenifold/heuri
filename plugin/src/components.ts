import type { Annotation, Severity, TileWithAnnotations, ViewportSection } from "./types";
import { BODY_TEXT_COLOR, FONT, FONT_BOLD, SEVERITY_COLOR, SEVERITY_LABEL } from "./theme";

const PIN_SIZE = 26;
const CARD_WIDTH = 300;
const DESKTOP_DISPLAY_SCALE = 0.5;
const MOBILE_DISPLAY_SCALE = 1;

// Plugin-data roles let later commands (Renumber, Refresh Key Fixes) find and
// read back the *current* state of the canvas — which may have been edited
// by a designer — rather than relying on the original AI response data.
export const ROLE = {
  pageRoot: "page-root",
  pin: "pin",
  card: "card",
  keyFixesList: "key-fixes-list",
  tile: "tile",
  viewportSection: "viewport-section",
  cover: "cover",
} as const;

function solid(color: RGB): SolidPaint {
  return { type: "SOLID", color };
}

function text(content: string, opts: { size: number; color: RGB; bold?: boolean; width?: number; name?: string }): TextNode {
  const node = figma.createText();
  node.fontName = opts.bold ? FONT_BOLD : FONT;
  node.fontSize = opts.size;
  node.fills = [solid(opts.color)];
  if (opts.width) {
    node.resize(opts.width, node.height);
    node.textAutoResize = "HEIGHT";
  }
  node.characters = content;
  if (opts.name) node.name = opts.name;
  return node;
}

function numberedBadge(number: number, severity: Severity, size: number): FrameNode {
  const frame = figma.createFrame();
  frame.name = "Badge";
  frame.resize(size, size);
  frame.cornerRadius = size / 2;
  frame.fills = [solid(SEVERITY_COLOR[severity].badge)];
  frame.layoutMode = "HORIZONTAL";
  frame.primaryAxisAlignItems = "CENTER";
  frame.counterAxisAlignItems = "CENTER";
  frame.primaryAxisSizingMode = "FIXED";
  frame.counterAxisSizingMode = "FIXED";
  const label = text(String(number).padStart(2, "0"), {
    size: size * 0.42,
    color: { r: 1, g: 1, b: 1 },
    bold: true,
    name: "badge-number",
  });
  frame.appendChild(label);
  return frame;
}

export function createPin(number: number, severity: Severity, centerX: number, centerY: number): FrameNode {
  const badge = numberedBadge(number, severity, PIN_SIZE);
  badge.name = `Pin ${String(number).padStart(2, "0")}`;
  badge.setPluginData("heuriRole", ROLE.pin);
  badge.setPluginData("severity", severity);
  badge.x = centerX - PIN_SIZE / 2;
  badge.y = centerY - PIN_SIZE / 2;
  return badge;
}

// A legend row for the cover page — a plain colored dot (no number, unlike a
// canvas pin) next to the severity's label and a plain-language explanation
// of what it means, so anyone opening the deck cold (not just the reviewer
// who built it) knows how to read the color coding.
export function createLegendEntry(severity: Severity, description: string): FrameNode {
  const row = figma.createFrame();
  row.name = `Legend — ${SEVERITY_LABEL[severity]}`;
  row.layoutMode = "HORIZONTAL";
  row.primaryAxisSizingMode = "AUTO";
  row.counterAxisSizingMode = "AUTO";
  row.itemSpacing = 14;
  row.counterAxisAlignItems = "MIN";
  row.fills = [];

  const dot = figma.createEllipse();
  dot.name = "Swatch";
  dot.resize(16, 16);
  dot.fills = [solid(SEVERITY_COLOR[severity].badge)];

  const textCol = figma.createFrame();
  textCol.name = "Text";
  textCol.layoutMode = "VERTICAL";
  textCol.primaryAxisSizingMode = "AUTO";
  textCol.counterAxisSizingMode = "FIXED";
  textCol.resize(600, textCol.height);
  textCol.itemSpacing = 2;
  textCol.fills = [];
  textCol.appendChild(text(SEVERITY_LABEL[severity], { size: 14, color: BODY_TEXT_COLOR, bold: true, name: "Label" }));
  textCol.appendChild(text(description, { size: 12, color: BODY_TEXT_COLOR, width: 600, name: "Description" }));

  row.appendChild(dot);
  row.appendChild(textCol);
  return row;
}

export function createAnnotationCard(number: number, severity: Severity, annotation: Annotation): FrameNode {
  const card = figma.createFrame();
  card.name = `Comment ${String(number).padStart(2, "0")} — ${annotation.title}`;
  card.setPluginData("heuriRole", ROLE.card);
  card.setPluginData("severity", severity);
  card.setPluginData("title", annotation.title);
  card.layoutMode = "VERTICAL";
  card.primaryAxisSizingMode = "AUTO";
  card.counterAxisSizingMode = "FIXED";
  card.resize(CARD_WIDTH, card.height);
  card.itemSpacing = 6;
  card.paddingTop = 14;
  card.paddingBottom = 14;
  card.paddingLeft = 16;
  card.paddingRight = 16;
  card.cornerRadius = 8;
  card.fills = [solid(SEVERITY_COLOR[severity].cardBg)];

  const headerRow = figma.createFrame();
  headerRow.name = "Badge Row";
  headerRow.layoutMode = "HORIZONTAL";
  headerRow.primaryAxisSizingMode = "AUTO";
  headerRow.counterAxisSizingMode = "AUTO";
  headerRow.itemSpacing = 8;
  headerRow.counterAxisAlignItems = "CENTER";
  headerRow.fills = [];
  // Plain numberedBadge (not createPin) — this badge is the card's inline
  // number chip, not a standalone canvas pin, so it isn't tagged with a role.
  headerRow.appendChild(numberedBadge(number, severity, 22));
  headerRow.appendChild(
    text(SEVERITY_LABEL[severity], { size: 13, color: SEVERITY_COLOR[severity].text, bold: true, name: "Severity Label" })
  );
  card.appendChild(headerRow);

  card.appendChild(text(annotation.title, { size: 14, color: BODY_TEXT_COLOR, bold: true, width: CARD_WIDTH - 32, name: "Title" }));
  card.appendChild(
    text(annotation.description, { size: 12, color: BODY_TEXT_COLOR, width: CARD_WIDTH - 32, name: "Description" })
  );
  card.appendChild(
    text(`Heuristic: ${annotation.heuristic}`, { size: 11, color: SEVERITY_COLOR[severity].text, width: CARD_WIDTH - 32, name: "Heuristic" })
  );

  return card;
}

// Image bytes are fetched by the UI iframe (a real browser context) and
// passed in here already — the plugin main thread's sandbox does not have
// real fetch/network capability (Figma's own guidance: do network requests
// in the UI iframe, pass results to the main thread), which is why
// figma.createImageAsync(url) from the main thread was unreliable. Using the
// synchronous, bytes-based figma.createImage() here avoids that entirely.
// Returns an `error` result (never throws) if the bytes are somehow invalid,
// so callers can skip this tile rather than leaving a broken frame behind.
export async function createTileFrame(
  tile: TileWithAnnotations,
  startNumber: number,
  scale: number,
  viewportLabel: string,
  tileIndex: number
): Promise<{ frame: FrameNode; count: number } | { error: string }> {
  let image: Image;
  try {
    image = figma.createImage(tile.imageBytes);
  } catch (err) {
    return {
      error: `${viewportLabel} screenshot ${tileIndex + 1} failed to load — (${String(err)})`,
    };
  }

  const displayWidth = tile.width * scale;
  const displayHeight = tile.height * scale;

  const frame = figma.createFrame();
  frame.name = `${viewportLabel} Screenshot ${tileIndex + 1}`;
  frame.setPluginData("heuriRole", ROLE.tile);
  frame.resize(displayWidth, displayHeight);
  frame.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
  frame.clipsContent = true;

  tile.annotations.forEach((annotation, i) => {
    const pin = createPin(startNumber + i, annotation.severity, (annotation.x_pct / 100) * displayWidth, (annotation.y_pct / 100) * displayHeight);
    frame.appendChild(pin);
  });

  return { frame, count: tile.annotations.length };
}

const ROW_HEADING_GAP = 16;
const CARD_GAP = 12;
// Card badge sits near the top of the card — nudge the card up by roughly
// half the inline badge size so the badge (not the card's top edge) is what
// visually lines up with the pin's center.
const CARD_BADGE_CENTER_OFFSET = 11;

interface PendingCard {
  number: number;
  severity: Severity;
  annotation: Annotation;
  pinY: number; // absolute Y within tileStack's own coordinate space
}

export async function buildViewportSection(
  title: string,
  section: ViewportSection,
  scale: number,
  startNumber: number
): Promise<{ row: FrameNode; cardColumn: FrameNode; nextNumber: number; warnings: string[] }> {
  const heading = text(title, { size: 20, color: BODY_TEXT_COLOR, bold: true, name: "Heading" });

  const tileStack = figma.createFrame();
  tileStack.name = "Screenshots";
  tileStack.layoutMode = "VERTICAL";
  tileStack.primaryAxisSizingMode = "AUTO";
  tileStack.counterAxisSizingMode = "AUTO";
  tileStack.itemSpacing = 0;
  tileStack.fills = [];

  const warnings: string[] = [];
  const pending: PendingCard[] = [];
  let number = startNumber;
  let tileCursorY = 0;

  for (const [tileIndex, tile] of section.tiles.entries()) {
    const result = await createTileFrame(tile, number, scale, title, tileIndex);
    if ("error" in result) {
      warnings.push(result.error);
      continue;
    }
    tileStack.appendChild(result.frame);
    for (const annotation of tile.annotations) {
      pending.push({ number, severity: annotation.severity, annotation, pinY: tileCursorY + (annotation.y_pct / 100) * result.frame.height });
      number += 1;
    }
    tileCursorY += result.frame.height;
  }

  // Cards are placed so their badge lines up with their pin's height on the
  // screenshot (top-to-bottom), rather than just stacking in list order —
  // makes it possible to scan across from a pin to its comment. When pins
  // land close together, the lower card gets nudged down just enough to
  // avoid overlapping the one above; best-effort, not pixel-perfect.
  const headingOffset = heading.height + ROW_HEADING_GAP;
  const cardColumn = figma.createFrame();
  cardColumn.name = "Comments";
  cardColumn.layoutMode = "NONE";
  cardColumn.fills = [];
  cardColumn.resize(CARD_WIDTH, Math.max(headingOffset + tileCursorY, 1));

  let cursorY = 0;
  for (const item of pending) {
    const card = createAnnotationCard(item.number, item.severity, item.annotation);
    const desiredY = headingOffset + item.pinY - CARD_BADGE_CENTER_OFFSET;
    const cardY = Math.max(desiredY, cursorY);
    card.x = 0;
    card.y = cardY;
    cardColumn.appendChild(card);
    cursorY = cardY + card.height + CARD_GAP;
  }
  cardColumn.resize(CARD_WIDTH, Math.max(cursorY - CARD_GAP, headingOffset + tileCursorY, 1));

  const row = figma.createFrame();
  row.name = `${title} Screenshots`;
  row.layoutMode = "VERTICAL";
  row.primaryAxisSizingMode = "AUTO";
  row.counterAxisSizingMode = "AUTO";
  row.itemSpacing = ROW_HEADING_GAP;
  row.fills = [];
  row.appendChild(heading);
  row.appendChild(tileStack);

  return { row, cardColumn, nextNumber: number, warnings };
}

export { DESKTOP_DISPLAY_SCALE, MOBILE_DISPLAY_SCALE };
