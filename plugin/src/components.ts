import type { Annotation, Severity, TileWithAnnotations, ViewportSection } from "./types";
import { BODY_TEXT_COLOR, FONT, FONT_BOLD, loadFonts, SEVERITY_COLOR, SEVERITY_LABEL } from "./theme";

// Distinct from SEVERITY_LABEL (used for display text) — these are the
// variant *values* encoded into each master component's name before
// figma.combineAsVariants() ("Severity=<value>"), kept slash-free to avoid
// any ambiguity with Figma's other "/"-separated component naming
// convention (asset-panel grouping).
const SEVERITY_VARIANT_VALUE: Record<Severity, string> = {
  "needs-fix": "Needs to be fixed",
  improvement: "Areas of improvement",
  idea: "Idea or Recommendation",
  good: "This is good",
};

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
  recommendations: "recommendations",
  evaluationSection: "evaluation-section",
} as const;

// Reuses the four severity colors for recommendation priority — same visual
// language, different meaning ("how urgent" instead of "what kind of finding").
const PRIORITY_COLOR: Record<"high" | "medium" | "low", { bg: RGB; text: RGB }> = {
  high: { bg: SEVERITY_COLOR["needs-fix"].cardBg, text: SEVERITY_COLOR["needs-fix"].text },
  medium: { bg: SEVERITY_COLOR.improvement.cardBg, text: SEVERITY_COLOR.improvement.text },
  low: { bg: SEVERITY_COLOR.idea.cardBg, text: SEVERITY_COLOR.idea.text },
};

function solid(color: RGB): SolidPaint {
  return { type: "SOLID", color };
}

// Shared Color Styles for the 4 severity badge/card colors — same visual
// result as an inline SolidPaint, but these show up in Figma's own Styles
// panel and are reusable/publishable across the file. Cached in-memory per
// plugin session (styles don't change at runtime); creation is idempotent —
// reuses an existing "Heuri/…" style by name if one's already in the file
// (e.g. from a previous session) instead of creating a duplicate.
let badgeStyleIds: Record<Severity, string> | null = null;
let cardBgStyleIds: Record<Severity, string> | null = null;

async function findOrCreatePaintStyle(name: string, color: RGB): Promise<string> {
  const existing = (await figma.getLocalPaintStylesAsync()).find((s) => s.name === name);
  if (existing) return existing.id;
  const style = figma.createPaintStyle();
  style.name = name;
  style.paints = [solid(color)];
  return style.id;
}

export async function ensureSeverityStyles(): Promise<void> {
  if (badgeStyleIds && cardBgStyleIds) return;
  const badges: Partial<Record<Severity, string>> = {};
  const cardBgs: Partial<Record<Severity, string>> = {};
  for (const severity of Object.keys(SEVERITY_LABEL) as Severity[]) {
    badges[severity] = await findOrCreatePaintStyle(`Heuri/Badge/${SEVERITY_LABEL[severity]}`, SEVERITY_COLOR[severity].badge);
    cardBgs[severity] = await findOrCreatePaintStyle(`Heuri/Card Background/${SEVERITY_LABEL[severity]}`, SEVERITY_COLOR[severity].cardBg);
  }
  badgeStyleIds = badges as Record<Severity, string>;
  cardBgStyleIds = cardBgs as Record<Severity, string>;
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

// --- Master component library ("Heuri Components" page) -------------------
//
// Pins and comment cards are instances of shared Figma components, one
// variant per severity — a designer can restyle the whole deck by editing
// the master once, and severity changes on an existing comment become a
// native "swap variant" instead of a hand-mutated fill. Built once per file
// (idempotent — reuses an existing "Heuri Components" page/component set by
// name if one already exists, e.g. from a previous session), lazily on
// first use, and cached in-memory for the rest of the plugin session.
//
// Node-content overrides (badge number, title, description, heuristic,
// assignee, resolved indicator) are plain per-instance mutations via
// findOne-by-name — not formal TEXT-type component properties — since
// Figma's own guidance is that direct .characters changes on a
// property-managed text layer can be overridden by the component property
// system on render; leaving these as ordinary overridable layers sidesteps
// that entirely and matches how the rest of this codebase already reads
// content back off nodes (by name, not by component property).
const LIBRARY_PAGE_NAME = "Heuri Components";
const BADGE_COMPONENT_SET_NAME = "Badge";
const CARD_COMPONENT_SET_NAME = "Annotation Card";

let badgeComponentSet: ComponentSetNode | null = null;
let cardComponentSet: ComponentSetNode | null = null;

function findVariant(set: ComponentSetNode, severity: Severity): ComponentNode {
  const name = `Severity=${SEVERITY_VARIANT_VALUE[severity]}`;
  const variant = set.children.find((c) => c.name === name) as ComponentNode | undefined;
  if (!variant) throw new Error(`Missing "${name}" variant in component set "${set.name}" — the component library may be out of date.`);
  return variant;
}

function layoutVariantsInARow(components: ComponentNode[], y: number, gap: number): void {
  let x = 0;
  for (const c of components) {
    c.x = x;
    c.y = y;
    x += c.width + gap;
  }
}

function buildBadgeMasterVariant(severity: Severity): ComponentNode {
  const comp = figma.createComponent();
  comp.name = `Severity=${SEVERITY_VARIANT_VALUE[severity]}`;
  comp.resize(PIN_SIZE, PIN_SIZE);
  comp.cornerRadius = PIN_SIZE / 2;
  if (badgeStyleIds) comp.fillStyleId = badgeStyleIds[severity];
  else comp.fills = [solid(SEVERITY_COLOR[severity].badge)];
  comp.layoutMode = "HORIZONTAL";
  comp.primaryAxisAlignItems = "CENTER";
  comp.counterAxisAlignItems = "CENTER";
  comp.primaryAxisSizingMode = "FIXED";
  comp.counterAxisSizingMode = "FIXED";
  comp.appendChild(text("00", { size: PIN_SIZE * 0.42, color: { r: 1, g: 1, b: 1 }, bold: true, name: "badge-number" }));
  return comp;
}

// A card's inline header badge is a *nested instance* of the same Badge
// component the standalone pin uses (just shrunk down) — one master, two
// places it shows up, matching the "one restyle affects everywhere" goal.
function createBadgeInstance(severity: Severity, size: number): InstanceNode {
  const variant = findVariant(badgeComponentSet!, severity);
  const instance = variant.createInstance();
  instance.resize(size, size);
  const numText = instance.findOne((n) => n.name === "badge-number" && n.type === "TEXT") as TextNode | null;
  if (numText) numText.fontSize = size * 0.42;
  return instance;
}

function buildCardMasterVariant(severity: Severity): ComponentNode {
  const card = figma.createComponent();
  card.name = `Severity=${SEVERITY_VARIANT_VALUE[severity]}`;
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
  if (cardBgStyleIds) card.fillStyleId = cardBgStyleIds[severity];
  else card.fills = [solid(SEVERITY_COLOR[severity].cardBg)];

  const headerRow = figma.createFrame();
  headerRow.name = "Badge Row";
  headerRow.layoutMode = "HORIZONTAL";
  headerRow.primaryAxisSizingMode = "AUTO";
  headerRow.counterAxisSizingMode = "AUTO";
  headerRow.itemSpacing = 8;
  headerRow.counterAxisAlignItems = "CENTER";
  headerRow.fills = [];
  headerRow.appendChild(createBadgeInstance(severity, 22));
  headerRow.appendChild(text(SEVERITY_LABEL[severity], { size: 13, color: SEVERITY_COLOR[severity].text, bold: true, name: "Severity Label" }));
  // Unfilled by default — "Toggle resolved" (code.ts, via setCardResolved)
  // fills it solid green and strikes through the title when a finding is
  // marked addressed.
  const resolvedIndicator = figma.createEllipse();
  resolvedIndicator.name = "Resolved Indicator";
  resolvedIndicator.resize(12, 12);
  resolvedIndicator.fills = [];
  resolvedIndicator.strokes = [solid(SEVERITY_COLOR[severity].text)];
  resolvedIndicator.strokeWeight = 1.5;
  headerRow.appendChild(resolvedIndicator);
  card.appendChild(headerRow);

  card.appendChild(text("Title", { size: 14, color: BODY_TEXT_COLOR, bold: true, width: CARD_WIDTH - 32, name: "Title" }));
  card.appendChild(text("Description", { size: 12, color: BODY_TEXT_COLOR, width: CARD_WIDTH - 32, name: "Description" }));
  card.appendChild(text("Heuristic: ", { size: 11, color: SEVERITY_COLOR[severity].text, width: CARD_WIDTH - 32, name: "Heuristic" }));
  // Always present in the master (identical structure across variants keeps
  // overrides matching correctly on a variant swap) — hidden by default;
  // per-instance visibility is toggled on only when an assignee is set.
  // Auto-layout skips invisible children, so a hidden line takes no space.
  const assignee = text("Assigned to: ", { size: 11, color: BODY_TEXT_COLOR, width: CARD_WIDTH - 32, name: "Assignee" });
  assignee.visible = false;
  card.appendChild(assignee);

  return card;
}

async function ensureComponentLibrary(): Promise<{ badgeSet: ComponentSetNode; cardSet: ComponentSetNode }> {
  if (badgeComponentSet && cardComponentSet) return { badgeSet: badgeComponentSet, cardSet: cardComponentSet };

  await ensureSeverityStyles();
  await loadFonts();

  const originalPage = figma.currentPage;
  let libraryPage = figma.root.children.find((p) => p.name === LIBRARY_PAGE_NAME) as PageNode | undefined;
  if (!libraryPage) {
    libraryPage = figma.createPage();
    libraryPage.name = LIBRARY_PAGE_NAME;
  }
  await figma.setCurrentPageAsync(libraryPage);

  let badgeSet = libraryPage.findOne((n) => n.type === "COMPONENT_SET" && n.name === BADGE_COMPONENT_SET_NAME) as ComponentSetNode | null;
  if (!badgeSet) {
    const variants = (Object.keys(SEVERITY_LABEL) as Severity[]).map(buildBadgeMasterVariant);
    layoutVariantsInARow(variants, 0, 40);
    badgeSet = figma.combineAsVariants(variants, libraryPage);
    badgeSet.name = BADGE_COMPONENT_SET_NAME;
    badgeSet.x = 0;
    badgeSet.y = 0;
  }
  badgeComponentSet = badgeSet;

  let cardSet = libraryPage.findOne((n) => n.type === "COMPONENT_SET" && n.name === CARD_COMPONENT_SET_NAME) as ComponentSetNode | null;
  if (!cardSet) {
    const variants = (Object.keys(SEVERITY_LABEL) as Severity[]).map(buildCardMasterVariant);
    layoutVariantsInARow(variants, 0, 40);
    cardSet = figma.combineAsVariants(variants, libraryPage);
    cardSet.name = CARD_COMPONENT_SET_NAME;
    cardSet.x = 0;
    cardSet.y = 200;
  }
  cardComponentSet = cardSet;

  await figma.setCurrentPageAsync(originalPage);
  return { badgeSet, cardSet };
}

export async function createPin(number: number, severity: Severity, centerX: number, centerY: number): Promise<InstanceNode> {
  await ensureComponentLibrary();
  const instance = createBadgeInstance(severity, PIN_SIZE);
  instance.name = `Pin ${String(number).padStart(2, "0")}`;
  instance.setPluginData("heuriRole", ROLE.pin);
  instance.setPluginData("severity", severity);
  const numText = instance.findOne((n) => n.name === "badge-number" && n.type === "TEXT") as TextNode | null;
  if (numText) numText.characters = String(number).padStart(2, "0");
  instance.x = centerX - PIN_SIZE / 2;
  instance.y = centerY - PIN_SIZE / 2;
  return instance;
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
  if (badgeStyleIds) dot.fillStyleId = badgeStyleIds[severity];
  else dot.fills = [solid(SEVERITY_COLOR[severity].badge)];

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

// Sets the overridable content on a card instance directly — plain findOne-
// by-name mutation, not formal component properties (see the library-builder
// comment above for why). Shared between initial creation and re-application
// after a severity variant swap (applySeverity), so both paths stay in sync.
function applyCardContent(
  card: InstanceNode,
  content: { title: string; description: string; heuristic: string; assignee: string }
): void {
  const titleNode = card.findOne((n) => n.name === "Title" && n.type === "TEXT") as TextNode | null;
  if (titleNode) titleNode.characters = content.title;
  const descNode = card.findOne((n) => n.name === "Description" && n.type === "TEXT") as TextNode | null;
  if (descNode) descNode.characters = content.description;
  const heuristicNode = card.findOne((n) => n.name === "Heuristic" && n.type === "TEXT") as TextNode | null;
  if (heuristicNode) heuristicNode.characters = `Heuristic: ${content.heuristic}`;
  const assigneeNode = card.findOne((n) => n.name === "Assignee" && n.type === "TEXT") as TextNode | null;
  if (assigneeNode) {
    assigneeNode.visible = Boolean(content.assignee);
    if (content.assignee) assigneeNode.characters = `Assigned to: ${content.assignee}`;
  }
}

export async function createAnnotationCard(number: number, severity: Severity, annotation: Annotation): Promise<InstanceNode> {
  const { cardSet } = await ensureComponentLibrary();
  const variant = findVariant(cardSet, severity);
  const card = variant.createInstance();
  card.name = `Comment ${String(number).padStart(2, "0")} — ${annotation.title}`;
  card.setPluginData("heuriRole", ROLE.card);
  card.setPluginData("severity", severity);
  card.setPluginData("title", annotation.title);
  // heuristic/description are stored as plugin data (not just parsed back
  // from the visible text) so the "Generate final recommendations" pass can
  // read a clean value directly — same tradeoff already accepted for title:
  // if a designer retypes the text node directly instead of editing through
  // the plugin, this metadata can go stale relative to what's visible.
  card.setPluginData("heuristic", annotation.heuristic);
  card.setPluginData("description", annotation.description);
  card.setPluginData("resolved", "false");
  card.setPluginData("assignee", annotation.assignee || "");

  const numText = card.findOne((n) => n.name === "badge-number" && n.type === "TEXT") as TextNode | null;
  if (numText) numText.characters = String(number).padStart(2, "0");

  applyCardContent(card, {
    title: annotation.title,
    description: annotation.description,
    heuristic: annotation.heuristic,
    assignee: annotation.assignee || "",
  });

  return card;
}

// Toggled by the selection-based "Mark resolved" command (code.ts) — clicking
// a canvas node can't call back into plugin code, only selection-change can,
// so this is "select card(s), click the button," same as every other
// selection-based command.
export function setCardResolved(card: InstanceNode, resolved: boolean): void {
  card.setPluginData("resolved", resolved ? "true" : "false");
  const indicator = card.findOne((n) => n.name === "Resolved Indicator") as EllipseNode | null;
  if (indicator) indicator.fills = resolved ? [solid(SEVERITY_COLOR.good.badge)] : [];
  const title = card.findOne((n) => n.name === "Title") as TextNode | null;
  if (title) title.textDecoration = resolved ? "STRIKETHROUGH" : "NONE";
  card.opacity = resolved ? 0.55 : 1;
}

// Used by "Set severity for selected" (code.ts, bulk operation). Severity is
// the ComponentSet's one variant property, so changing it is a native
// setProperties() variant swap rather than a hand-mutated fill — this is
// the whole point of the component conversion. Node identity (ids) is
// preserved by a variant swap, unlike the old recreate-and-swap approach, so
// Connector lines stay attached.
//
// Belt-and-suspenders: Figma's own guidance warns that direct .characters
// overrides on a *component-property-bound* text layer can be reset by the
// property system on render. This codebase deliberately does not bind
// title/description/heuristic/assignee as formal component properties (see
// the library-builder comment), so that specific gotcha shouldn't apply —
// but since this can't be verified without a live pass in the Figma app,
// every content override is explicitly re-applied from plugin data
// immediately after the swap regardless, at negligible extra cost.
export function applySeverity(pin: InstanceNode, card: InstanceNode, severity: Severity): void {
  const content = {
    title: card.getPluginData("title") || "Untitled",
    description: card.getPluginData("description") || "",
    heuristic: card.getPluginData("heuristic") || "General",
    assignee: card.getPluginData("assignee") || "",
  };
  const resolved = card.getPluginData("resolved") === "true";
  const numText = pin.findOne((n) => n.name === "badge-number" && n.type === "TEXT") as TextNode | null;
  const number = numText?.characters;

  pin.setProperties({ Severity: SEVERITY_VARIANT_VALUE[severity] });
  card.setProperties({ Severity: SEVERITY_VARIANT_VALUE[severity] });
  pin.setPluginData("severity", severity);
  card.setPluginData("severity", severity);

  // findOne recurses through the whole subtree (including nested instances),
  // so this reaches the card's inline badge number the same way it reaches
  // the standalone pin's.
  const newPinNumText = pin.findOne((n) => n.name === "badge-number" && n.type === "TEXT") as TextNode | null;
  if (newPinNumText && number) newPinNumText.characters = number;
  const newCardNumText = card.findOne((n) => n.name === "badge-number" && n.type === "TEXT") as TextNode | null;
  if (newCardNumText && number) newCardNumText.characters = number;

  applyCardContent(card, content);
  setCardResolved(card, resolved);
}

function findBadgeNumber(node: InstanceNode): number | null {
  const t = node.findOne((n) => n.name === "badge-number" && n.type === "TEXT") as TextNode | null;
  if (!t) return null;
  const n = parseInt(t.characters, 10);
  return Number.isNaN(n) ? null : n;
}

// A dashed line from a pin to its comment card — ties them together visually
// beyond rough Y-alignment, since a card's badge can only be nudged so close
// to its pin's actual height before it'd overlap the card above it. Uses
// endpointNodeId (not fixed x/y), so the line tracks the pin/card if either
// is dragged afterward — a real Figma Connector, not a drawn line.
export function createConnectorForPair(pin: InstanceNode, card: InstanceNode, severity: Severity, parent: FrameNode): void {
  const connector = figma.createConnector();
  connector.name = "Pin–Card Connector";
  // Connectors aren't auto-layout participants (no layoutPositioning on
  // ConnectorNode) — appending one into an auto-layout frame doesn't disturb
  // that frame's flow; the connector just floats, tracking its endpoints.
  parent.appendChild(connector);
  connector.connectorStart = { endpointNodeId: pin.id, magnet: "AUTO" };
  connector.connectorEnd = { endpointNodeId: card.id, magnet: "AUTO" };
  connector.strokes = [solid(SEVERITY_COLOR[severity].text)];
  connector.strokeWeight = 1;
  connector.dashPattern = [3, 3];
}

// Batch version for a freshly built viewport section — matches every pin in
// `row` to its card in `cardColumn` by shared badge number (same matching
// approach renumberPage uses) and connects each pair.
export function connectPinsToCards(parent: FrameNode, row: FrameNode, cardColumn: FrameNode): void {
  const pins = row.findAll((n) => n.getPluginData("heuriRole") === ROLE.pin) as InstanceNode[];
  const cards = cardColumn.findAll((n) => n.getPluginData("heuriRole") === ROLE.card) as InstanceNode[];
  const cardsByNumber = new Map<number, InstanceNode>();
  for (const card of cards) {
    const n = findBadgeNumber(card);
    if (n !== null) cardsByNumber.set(n, card);
  }
  for (const pin of pins) {
    const n = findBadgeNumber(pin);
    const card = n !== null ? cardsByNumber.get(n) : undefined;
    if (!card) continue;
    const severity = (pin.getPluginData("severity") as Severity) || "idea";
    createConnectorForPair(pin, card, severity, parent);
  }
}

const RECOMMENDATION_WIDTH = 788;

// A strategic recommendation card for the Final Recommendations page — same
// visual language as an annotation card (colored background, badge) but
// keyed by priority instead of severity, and wider since these live in a
// single full-width column rather than a screenshot-adjacent comment rail.
export function createRecommendationCard(rec: { title: string; description: string; priority: "high" | "medium" | "low" }): FrameNode {
  const card = figma.createFrame();
  card.name = `Recommendation — ${rec.title}`;
  card.layoutMode = "VERTICAL";
  card.primaryAxisSizingMode = "AUTO";
  card.counterAxisSizingMode = "FIXED";
  card.resize(RECOMMENDATION_WIDTH, card.height);
  card.itemSpacing = 8;
  card.paddingTop = 16;
  card.paddingBottom = 16;
  card.paddingLeft = 18;
  card.paddingRight = 18;
  card.cornerRadius = 8;
  card.fills = [solid(PRIORITY_COLOR[rec.priority].bg)];

  const badge = figma.createFrame();
  badge.name = "Priority Badge";
  badge.layoutMode = "HORIZONTAL";
  badge.primaryAxisSizingMode = "AUTO";
  badge.counterAxisSizingMode = "AUTO";
  badge.paddingTop = 3;
  badge.paddingBottom = 3;
  badge.paddingLeft = 8;
  badge.paddingRight = 8;
  badge.cornerRadius = 10;
  badge.fills = [solid(PRIORITY_COLOR[rec.priority].text)];
  badge.appendChild(text(`${rec.priority.toUpperCase()} PRIORITY`, { size: 10, color: { r: 1, g: 1, b: 1 }, bold: true }));
  card.appendChild(badge);

  card.appendChild(text(rec.title, { size: 16, color: BODY_TEXT_COLOR, bold: true, width: RECOMMENDATION_WIDTH - 36, name: "Title" }));
  card.appendChild(text(rec.description, { size: 13, color: BODY_TEXT_COLOR, width: RECOMMENDATION_WIDTH - 36, name: "Description" }));

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

  for (const [i, annotation] of tile.annotations.entries()) {
    const pin = await createPin(startNumber + i, annotation.severity, (annotation.x_pct / 100) * displayWidth, (annotation.y_pct / 100) * displayHeight);
    frame.appendChild(pin);
  }

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
    const card = await createAnnotationCard(item.number, item.severity, item.annotation);
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
