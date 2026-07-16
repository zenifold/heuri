/// <reference types="@figma/plugin-typings" />
import type { Annotation, CodeToUiMessage, CollectedFinding, PageResult, RecommendationsContent, Settings, Severity, UiToCodeMessage } from "./types";
import { loadFonts, HEADER_BAND_COLOR, PAGE_BG_COLOR, BODY_TEXT_COLOR, SEVERITY_COLOR, SEVERITY_LABEL, FONT, FONT_BOLD } from "./theme";
import { applySeverity, buildViewportSection, connectPinsToCards, createAnnotationCard, createConnectorForPair, createLegendEntry, createPin, createRecommendationCard, DESKTOP_DISPLAY_SCALE, ensureSeverityStyles, MOBILE_DISPLAY_SCALE, ROLE, setCardResolved } from "./components";

figma.showUI(__html__, { width: 440, height: 760, themeColors: true });

function post(message: CodeToUiMessage) {
  figma.ui.postMessage(message);
  // Selection-based, single-shot commands (renumber, refresh key fixes, add
  // comment, undo, bulk edits, resolve/assignee) all report through this one
  // message shape — surface a native toast alongside the panel's status line
  // so quick actions get immediate feedback even if the panel isn't in view.
  // Deliberately not hooked into "page-built"/"page-build-error", which fire
  // once per page during capture/analyze — that would spam a toast per page.
  if (message.type === "command-result") {
    figma.notify(message.message, { error: !message.ok, timeout: message.ok ? 2500 : 4000 });
  }
}

function solid(color: RGB): SolidPaint {
  return { type: "SOLID", color };
}

function makeText(content: string, size: number, color: RGB, bold = false, width?: number, name?: string): TextNode {
  const node = figma.createText();
  node.fontName = bold ? FONT_BOLD : FONT;
  node.fontSize = size;
  node.fills = [solid(color)];
  if (width) {
    node.resize(width, node.height);
    node.textAutoResize = "HEIGHT";
  }
  node.characters = content;
  if (name) node.name = name;
  return node;
}

function topNeedsFixTitles(page: PageResult, max = 4): string[] {
  const all: Annotation[] = [
    ...(page.desktop?.tiles.flatMap((t) => t.annotations) ?? []),
    ...(page.mobile?.tiles.flatMap((t) => t.annotations) ?? []),
  ];
  return all.filter((a) => a.severity === "needs-fix").slice(0, max).map((a) => a.title);
}

function buildKeyFixesList(fixes: string[]): FrameNode {
  const list = figma.createFrame();
  list.name = "Key Fixes List";
  list.setPluginData("heuriRole", ROLE.keyFixesList);
  list.layoutMode = "VERTICAL";
  list.primaryAxisSizingMode = "AUTO";
  list.counterAxisSizingMode = "FIXED";
  list.resize(360, list.height);
  list.itemSpacing = 4;
  list.fills = [];
  populateKeyFixesList(list, fixes);
  return list;
}

function populateKeyFixesList(list: FrameNode, fixes: string[]) {
  for (const child of [...list.children]) child.remove();
  if (fixes.length === 0) {
    list.appendChild(makeText("No high-severity issues flagged in this pass.", 12, BODY_TEXT_COLOR, false, 360));
  } else {
    for (const fix of fixes) {
      list.appendChild(makeText(`•  ${fix}`, 12, BODY_TEXT_COLOR, false, 360));
    }
  }
}

// Kept in the same order as the "Add your own comment" severity dropdown for
// consistency across the plugin.
const SEVERITY_ORDER: Severity[] = ["needs-fix", "improvement", "idea", "good"];
const SEVERITY_DESCRIPTIONS: Record<Severity, string> = {
  "needs-fix": "A clear usability problem that should be addressed.",
  improvement: "Currently works, but there's a concrete, describable way to make it better.",
  idea: "An optional, forward-looking suggestion — not a problem with what's there now.",
  good: "A genuine strength worth highlighting and preserving.",
};

// The deck's cover page — built once per review session (inside
// startReview, before any content pages), placed first, ahead of even the
// nav/footer captures. Gives anyone opening the file cold (not just whoever
// ran the review) the name of the evaluation, when it was generated, and how
// to read the pin/card color coding without needing it explained separately.
async function buildTitlePage(siteLabel: string, generatedAt: Date): Promise<FrameNode> {
  const root = figma.createFrame();
  root.name = "Cover";
  root.setPluginData("heuriRole", ROLE.cover);
  root.layoutMode = "VERTICAL";
  root.primaryAxisSizingMode = "AUTO";
  root.counterAxisSizingMode = "FIXED";
  root.resize(800, root.height);
  root.itemSpacing = 36;
  root.paddingTop = 64;
  root.paddingBottom = 64;
  root.paddingLeft = 64;
  root.paddingRight = 64;
  root.fills = [solid(PAGE_BG_COLOR)];

  const intro = figma.createFrame();
  intro.name = "Intro";
  intro.layoutMode = "VERTICAL";
  intro.primaryAxisSizingMode = "AUTO";
  intro.counterAxisSizingMode = "FIXED";
  intro.resize(672, intro.height);
  intro.itemSpacing = 10;
  intro.fills = [];
  intro.appendChild(makeText(`${siteLabel} — Heuristic Evaluation`, 32, BODY_TEXT_COLOR, true, 672, "Title"));
  intro.appendChild(
    makeText(
      `A UX heuristic review, evaluated against a 12-category usability framework. ` +
        `Generated ${generatedAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}. ` +
        `Findings are a first pass — reviewed, edited, and approved by the design team before final delivery.`,
      14,
      BODY_TEXT_COLOR,
      false,
      672,
      "Description"
    )
  );
  root.appendChild(intro);

  const legendSection = figma.createFrame();
  legendSection.name = "Legend Section";
  legendSection.layoutMode = "VERTICAL";
  legendSection.primaryAxisSizingMode = "AUTO";
  legendSection.counterAxisSizingMode = "AUTO";
  legendSection.itemSpacing = 16;
  legendSection.fills = [];
  legendSection.appendChild(makeText("How to read this deck", 18, BODY_TEXT_COLOR, true, undefined, "Legend Heading"));
  for (const severity of SEVERITY_ORDER) {
    legendSection.appendChild(await createLegendEntry(severity, SEVERITY_DESCRIPTIONS[severity]));
  }
  root.appendChild(legendSection);

  return root;
}

function buildHeaderBand(page: PageResult): FrameNode {
  const band = figma.createFrame();
  band.name = "Header";
  band.layoutMode = "HORIZONTAL";
  band.primaryAxisSizingMode = "FIXED";
  band.counterAxisSizingMode = "AUTO";
  band.resize(1400, band.height);
  band.itemSpacing = 40;
  band.paddingTop = 32;
  band.paddingBottom = 32;
  band.paddingLeft = 32;
  band.paddingRight = 32;
  band.fills = [solid(HEADER_BAND_COLOR)];
  band.cornerRadius = 4;

  const left = figma.createFrame();
  left.name = "Page Info";
  left.layoutMode = "VERTICAL";
  left.primaryAxisSizingMode = "AUTO";
  left.counterAxisSizingMode = "FIXED";
  left.resize(880, left.height);
  left.itemSpacing = 8;
  left.fills = [];
  left.appendChild(makeText(page.label, 28, BODY_TEXT_COLOR, true, undefined, "Title"));
  left.appendChild(makeText(page.url, 13, BODY_TEXT_COLOR, false, undefined, "URL"));
  left.appendChild(
    makeText(
      "Heuristic first pass. Review, edit, and approve findings below.",
      13,
      BODY_TEXT_COLOR,
      false,
      880,
      "Description"
    )
  );

  const right = figma.createFrame();
  right.name = "Key Fixes";
  right.layoutMode = "VERTICAL";
  right.primaryAxisSizingMode = "AUTO";
  right.counterAxisSizingMode = "FIXED";
  right.resize(360, right.height);
  right.itemSpacing = 6;
  right.fills = [];
  right.appendChild(makeText("Key Fixes", 15, BODY_TEXT_COLOR, true, undefined, "Heading"));
  right.appendChild(buildKeyFixesList(topNeedsFixTitles(page)));

  band.appendChild(left);
  band.appendChild(right);
  return band;
}

async function buildPageFrame(page: PageResult, numberStart: number): Promise<{ frame: FrameNode; nextNumber: number; warnings: string[] }> {
  const root = figma.createFrame();
  root.name = page.label;
  root.setPluginData("heuriRole", ROLE.pageRoot);
  root.setPluginData("pageLabel", page.label);
  root.layoutMode = "VERTICAL";
  root.primaryAxisSizingMode = "AUTO";
  root.counterAxisSizingMode = "AUTO";
  root.itemSpacing = 32;
  root.paddingTop = 40;
  root.paddingBottom = 40;
  root.paddingLeft = 40;
  root.paddingRight = 40;
  root.fills = [solid(PAGE_BG_COLOR)];

  root.appendChild(buildHeaderBand(page));

  let number = numberStart;
  const warnings: string[] = [];

  if (page.desktop) {
    const { row, cardColumn, nextNumber, warnings: sectionWarnings } = await buildViewportSection("Desktop Experience", page.desktop, DESKTOP_DISPLAY_SCALE, number);
    number = nextNumber;
    warnings.push(...sectionWarnings);
    const section = figma.createFrame();
    section.name = "Desktop Experience Section";
    section.setPluginData("heuriRole", ROLE.viewportSection);
    section.layoutMode = "HORIZONTAL";
    section.primaryAxisSizingMode = "AUTO";
    section.counterAxisSizingMode = "AUTO";
    section.itemSpacing = 24;
    section.fills = [];
    section.appendChild(row);
    section.appendChild(cardColumn);
    connectPinsToCards(section, row, cardColumn);
    root.appendChild(section);
  }

  if (page.mobile) {
    const { row, cardColumn, nextNumber, warnings: sectionWarnings } = await buildViewportSection("Mobile Experience", page.mobile, MOBILE_DISPLAY_SCALE, number);
    number = nextNumber;
    warnings.push(...sectionWarnings);
    const section = figma.createFrame();
    section.name = "Mobile Experience Section";
    section.setPluginData("heuriRole", ROLE.viewportSection);
    section.layoutMode = "HORIZONTAL";
    section.primaryAxisSizingMode = "AUTO";
    section.counterAxisSizingMode = "AUTO";
    section.itemSpacing = 24;
    section.fills = [];
    section.appendChild(row);
    section.appendChild(cardColumn);
    connectPinsToCards(section, row, cardColumn);
    root.appendChild(section);
  }

  return { frame: root, nextNumber: number, warnings };
}

// Mutable state for the in-progress review build, spanning multiple
// start-review/build-page/finish-review messages from the UI — and persisting
// across the capture and analyze phases (start-review is only sent once, at
// the start of a capture run). A page is built and placed on the canvas as
// soon as its screenshots are ready (no annotations yet), then later
// re-built in place — same x position, same frame identity in pageFrames —
// once AI analysis completes for it. The comment column has a fixed width
// regardless of how many cards it holds, so a page's overall frame width
// never changes between the two states and sibling pages never need to
// shift to make room.
let activeSection: SectionNode | null = null;
let nextX = 0;
const pageFrames = new Map<string, FrameNode>();

// Every previous evaluation's Section (and anything else already on the
// page) needs to be cleared *horizontally* before a new one starts — a new
// review always used to reset to x=0 unconditionally, which put a brand
// new cover/section directly on top of whatever a prior run (or a
// different evaluation entirely) had already placed at x=0. Re-running
// Capture screenshots for the same or a different site, without deleting
// the old evaluation first, silently produced exactly that: overlapping
// frames, text peeking out from behind newer content, broken-looking
// pages — easy to misread as "screenshots not loading."
function findSafeStartX(): number {
  let maxRight = 0;
  for (const child of figma.currentPage.children) {
    if ("x" in child && "width" in child) {
      maxRight = Math.max(maxRight, child.x + child.width);
    }
  }
  return maxRight > 0 ? maxRight + 200 : 0;
}

async function startReview(siteLabel: string) {
  await loadFonts();
  const startX = findSafeStartX();
  activeSection = figma.createSection();
  activeSection.name = `${siteLabel} — Heuristic Review`;
  activeSection.setPluginData("heuriRole", ROLE.evaluationSection);
  nextX = startX;
  pageFrames.clear();

  const cover = await buildTitlePage(siteLabel, new Date());
  cover.x = nextX;
  cover.y = 0;
  figma.currentPage.appendChild(cover);
  activeSection.appendChild(cover);
  nextX = cover.x + cover.width + 120;
}

async function buildPage(page: PageResult): Promise<string[]> {
  const existing = pageFrames.get(page.label);
  const x = existing ? existing.x : nextX;

  const { frame, warnings } = await buildPageFrame(page, 1);
  frame.x = x;
  frame.y = 0;
  figma.currentPage.appendChild(frame);
  activeSection?.appendChild(frame);
  pageFrames.set(page.label, frame);

  if (existing) {
    existing.remove();
  } else {
    nextX = x + frame.width + 120;
  }

  figma.viewport.scrollAndZoomIntoView(activeSection ? activeSection.children : [frame]);
  return warnings;
}

function finishReview() {
  if (activeSection && activeSection.children.length > 0) {
    figma.viewport.scrollAndZoomIntoView(activeSection.children);
  }
}

// Finds the enclosing page-root frame (tagged heuriRole="page-root") for
// whatever the designer currently has selected, so Renumber / Refresh Key
// Fixes can operate on "the page I'm looking at" without requiring an exact
// selection.
function findPageRoot(node: BaseNode | null): FrameNode | null {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === "FRAME" && current.getPluginData("heuriRole") === ROLE.pageRoot) {
      return current as FrameNode;
    }
    current = "parent" in current ? current.parent : null;
  }
  return null;
}

function getSelectedPageRoot(): FrameNode | null {
  const [selected] = figma.currentPage.selection;
  return selected ? findPageRoot(selected) : null;
}

function findBadgeNumberText(pinOrCard: InstanceNode): TextNode | null {
  const found = pinOrCard.findOne((n) => n.name === "badge-number" && n.type === "TEXT");
  return (found as TextNode) ?? null;
}

// Renumbers pins and their matching comment cards in reading order (each
// tile top-to-bottom within Desktop, then Mobile; pins within a tile ordered
// top-to-bottom, left-to-right) — closing gaps left behind after a designer
// deletes or adds cards during review.
async function renumberPage(root: FrameNode): Promise<number> {
  await loadFonts();

  const pins = root.findAll((n) => n.getPluginData("heuriRole") === ROLE.pin) as InstanceNode[];
  pins.sort((a, b) => {
    // Sort by the owning tile's vertical position first (via absolute Y of
    // the pin's parent), then by the pin's own position within that tile.
    const parentA = a.parent as SceneNode | null;
    const parentB = b.parent as SceneNode | null;
    const tileYA = parentA && "y" in parentA ? (parentA as FrameNode).absoluteTransform[1][2] : 0;
    const tileYB = parentB && "y" in parentB ? (parentB as FrameNode).absoluteTransform[1][2] : 0;
    if (Math.abs(tileYA - tileYB) > 1) return tileYA - tileYB;
    if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
    return a.x - b.x;
  });

  const cardsByOldNumber = new Map<number, InstanceNode>();
  for (const card of root.findAll((n) => n.getPluginData("heuriRole") === ROLE.card) as InstanceNode[]) {
    const numText = findBadgeNumberText(card);
    const oldNumber = numText ? parseInt(numText.characters, 10) : NaN;
    if (!Number.isNaN(oldNumber)) cardsByOldNumber.set(oldNumber, card);
  }

  pins.forEach((pin, i) => {
    const newNumber = i + 1;
    const numText = findBadgeNumberText(pin);
    const oldNumber = numText ? parseInt(numText.characters, 10) : NaN;
    if (numText) numText.characters = String(newNumber).padStart(2, "0");
    pin.name = `Pin ${String(newNumber).padStart(2, "0")}`;

    const card = !Number.isNaN(oldNumber) ? cardsByOldNumber.get(oldNumber) : undefined;
    if (card) {
      const cardNumText = findBadgeNumberText(card);
      if (cardNumText) cardNumText.characters = String(newNumber).padStart(2, "0");
      const title = card.getPluginData("title") || "Comment";
      card.name = `Comment ${String(newNumber).padStart(2, "0")} — ${title}`;
    }
  });

  return pins.length;
}

function getNextPinNumber(root: FrameNode): number {
  const pins = root.findAll((n) => n.getPluginData("heuriRole") === ROLE.pin) as InstanceNode[];
  let max = 0;
  for (const pin of pins) {
    const numText = findBadgeNumberText(pin);
    const n = numText ? parseInt(numText.characters, 10) : NaN;
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

// Locates the screenshot tile enclosing (or equal to) the given node, plus
// that viewport's comment column and the enclosing page — used by the
// drag-to-place comment drop handler to figure out which tile/page a drop
// landed on, without the designer needing to navigate the layer tree
// themselves.
function findTileContext(node: BaseNode | null): { tile: FrameNode; cardColumn: FrameNode; pageRoot: FrameNode; section: FrameNode } | null {
  let tile: FrameNode | null = null;
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === "FRAME" && current.getPluginData("heuriRole") === ROLE.tile) {
      tile = current as FrameNode;
      break;
    }
    current = "parent" in current ? current.parent : null;
  }
  if (!tile) return null;

  const pageRoot = findPageRoot(tile);
  if (!pageRoot) return null;

  let section: BaseNode | null = tile;
  while (section && !(section.type === "FRAME" && section.getPluginData("heuriRole") === ROLE.viewportSection)) {
    section = "parent" in section ? section.parent : null;
  }
  if (!section || section.type !== "FRAME") return null;

  const cardColumn = section.findOne((n) => n.name === "Comments" && n.type === "FRAME") as FrameNode | null;
  if (!cardColumn) return null;

  return { tile, cardColumn, pageRoot, section };
}

interface PinCardPair {
  pin: InstanceNode;
  card: InstanceNode;
  pageRoot: FrameNode;
}

// Bulk operations (delete, change severity) and per-comment commands (toggle
// resolved, set assignee) all work off native canvas multi-select instead of
// a custom list UI in the panel — Figma's Plugin API has no way to react to
// a click on a canvas node beyond selection change, so "select on canvas,
// click a button" is the same pattern already used by Renumber/Refresh Key
// Fixes. This resolves whatever's selected (a pin, a card, or something
// inside either) up to its pin+card pair, matched by shared badge number
// within the same page — same matching approach renumberPage already uses.
function resolvePinCardPairs(nodes: readonly SceneNode[]): PinCardPair[] {
  const pairs = new Map<string, PinCardPair>();
  for (const node of nodes) {
    let current: BaseNode | null = node;
    let pinOrCard: InstanceNode | null = null;
    while (current) {
      if (current.type === "INSTANCE" && (current.getPluginData("heuriRole") === ROLE.pin || current.getPluginData("heuriRole") === ROLE.card)) {
        pinOrCard = current as InstanceNode;
        break;
      }
      current = "parent" in current ? current.parent : null;
    }
    if (!pinOrCard) continue;

    const pageRoot = findPageRoot(pinOrCard);
    if (!pageRoot) continue;

    const numText = findBadgeNumberText(pinOrCard);
    const number = numText ? parseInt(numText.characters, 10) : NaN;
    if (Number.isNaN(number)) continue;

    const isPin = pinOrCard.getPluginData("heuriRole") === ROLE.pin;
    const matchByNumber = (n: InstanceNode) => {
      const t = findBadgeNumberText(n);
      return t ? parseInt(t.characters, 10) === number : false;
    };
    const pin = isPin ? pinOrCard : (pageRoot.findAll((n) => n.getPluginData("heuriRole") === ROLE.pin) as InstanceNode[]).find(matchByNumber);
    const card = !isPin ? pinOrCard : (pageRoot.findAll((n) => n.getPluginData("heuriRole") === ROLE.card) as InstanceNode[]).find(matchByNumber);
    if (!pin || !card) continue;

    pairs.set(pin.id, { pin, card, pageRoot });
  }
  return [...pairs.values()];
}

// Connector lines reference their pin/card by node id (not fixed position) —
// removing the pin/card without also removing any connector attached to it
// would leave a dangling connector on the canvas, so every deletion path
// goes through this instead of calling node.remove() directly.
function removeWithConnectors(node: SceneNode): void {
  for (const connector of node.attachedConnectors) connector.remove();
  node.remove();
}

// Recomputes the Key Fixes summary from whatever comment cards currently
// exist on the canvas — i.e. after the designer has edited, added, or
// removed AI suggestions — rather than the AI's original (now possibly
// stale) output.
async function refreshKeyFixes(root: FrameNode): Promise<number> {
  await loadFonts();

  const list = root.findOne((n) => n.getPluginData("heuriRole") === ROLE.keyFixesList) as FrameNode | null;
  if (!list) throw new Error("Could not find the Key Fixes list on this page.");

  const cards = root.findAll((n) => n.getPluginData("heuriRole") === ROLE.card) as InstanceNode[];
  const fixes = cards
    .filter((c) => c.getPluginData("severity") === "needs-fix")
    .slice(0, 4)
    .map((c) => c.getPluginData("title") || "Untitled finding");

  populateKeyFixesList(list, fixes);
  return fixes.length;
}

// Walks up from a card/pin to the nearest ancestor tagged as a viewport
// section (see buildPageFrame's "Desktop Experience Section" / "Mobile
// Experience Section" naming) and reads which viewport it belongs to from
// that frame's name.
function findViewportLabel(node: BaseNode): "desktop" | "mobile" {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === "FRAME" && current.getPluginData("heuriRole") === ROLE.viewportSection) {
      return current.name.toLowerCase().startsWith("mobile") ? "mobile" : "desktop";
    }
    current = "parent" in current ? current.parent : null;
  }
  return "desktop";
}

// Resolves which evaluation (Section) to operate on, given an optional id
// from the panel's "Evaluation" picker — falls back to the current session's
// activeSection only when no id is supplied (e.g. mid-session convenience).
// This is what lets Refresh Review Status / Generate Final Recommendations
// reach a *previous* evaluation instead of only ever the current session's,
// which is lost entirely on every plugin reopen (activeSection is in-memory
// main-thread state, not persisted).
async function resolveTargetSection(sectionId?: string): Promise<SectionNode | null> {
  if (sectionId) {
    const node = await figma.getNodeByIdAsync(sectionId);
    return node && node.type === "SECTION" ? node : null;
  }
  return activeSection;
}

// Reads every comment card currently on the canvas across the whole review
// section — not the original AI/import data, which may be stale relative to
// whatever the designer has since edited, deleted, or added — grouped by
// page. Skips the cover page (tagged heuriRole="cover", not "page-root") and
// any prior Final Recommendations page (tagged "recommendations") so
// regenerating doesn't feed its own previous output back into itself.
async function collectFindings(sectionId?: string): Promise<CollectedFinding[]> {
  const findings: CollectedFinding[] = [];
  const section = await resolveTargetSection(sectionId);
  if (!section) return findings;

  for (const child of section.children) {
    if (child.type !== "FRAME" || child.getPluginData("heuriRole") !== ROLE.pageRoot) continue;
    const pageLabel = child.getPluginData("pageLabel") || child.name;
    const cards = child.findAll((n) => n.getPluginData("heuriRole") === ROLE.card) as InstanceNode[];
    for (const card of cards) {
      findings.push({
        page: pageLabel,
        viewport: findViewportLabel(card),
        severity: (card.getPluginData("severity") as Severity) || "idea",
        heuristic: card.getPluginData("heuristic") || "General",
        title: card.getPluginData("title") || "Untitled",
        description: card.getPluginData("description") || "",
        resolved: card.getPluginData("resolved") === "true",
        assignee: card.getPluginData("assignee") || "",
      });
    }
  }
  return findings;
}

// The deck's closing synthesis page — an AI-generated summary of themes and
// strategic recommendations across every finding on the canvas at the time
// it's generated, not per-page detail. Placed last (rightmost), and
// re-generating it replaces the previous version in place rather than
// creating a duplicate, same pattern as buildPage's in-place rebuild.
function buildRecommendationsPage(siteLabel: string, content: RecommendationsContent): FrameNode {
  const root = figma.createFrame();
  root.name = "Final Recommendations";
  root.setPluginData("heuriRole", ROLE.recommendations);
  root.layoutMode = "VERTICAL";
  root.primaryAxisSizingMode = "AUTO";
  root.counterAxisSizingMode = "FIXED";
  root.resize(900, root.height);
  root.itemSpacing = 32;
  root.paddingTop = 56;
  root.paddingBottom = 56;
  root.paddingLeft = 56;
  root.paddingRight = 56;
  root.fills = [solid(PAGE_BG_COLOR)];

  root.appendChild(makeText(`${siteLabel} — Final Recommendations`, 28, BODY_TEXT_COLOR, true, 788, "Title"));
  root.appendChild(makeText(content.summary, 14, BODY_TEXT_COLOR, false, 788, "Summary"));

  const statsRow = figma.createFrame();
  statsRow.name = "Stats";
  statsRow.layoutMode = "HORIZONTAL";
  statsRow.primaryAxisSizingMode = "AUTO";
  statsRow.counterAxisSizingMode = "AUTO";
  statsRow.itemSpacing = 20;
  statsRow.counterAxisAlignItems = "CENTER";
  statsRow.fills = [];
  for (const severity of SEVERITY_ORDER) {
    const count = content.counts[severity] ?? 0;
    const chip = figma.createFrame();
    chip.name = `Count — ${SEVERITY_LABEL[severity]}`;
    chip.layoutMode = "HORIZONTAL";
    chip.primaryAxisSizingMode = "AUTO";
    chip.counterAxisSizingMode = "AUTO";
    chip.itemSpacing = 6;
    chip.counterAxisAlignItems = "CENTER";
    chip.fills = [];
    const dot = figma.createEllipse();
    dot.resize(10, 10);
    dot.fills = [solid(SEVERITY_COLOR[severity].badge)];
    chip.appendChild(dot);
    chip.appendChild(makeText(`${count} ${SEVERITY_LABEL[severity]}`, 12, BODY_TEXT_COLOR, false, undefined, "Count"));
    statsRow.appendChild(chip);
  }
  root.appendChild(statsRow);

  const themesSection = figma.createFrame();
  themesSection.name = "Themes Section";
  themesSection.layoutMode = "VERTICAL";
  themesSection.primaryAxisSizingMode = "AUTO";
  themesSection.counterAxisSizingMode = "AUTO";
  themesSection.itemSpacing = 8;
  themesSection.fills = [];
  themesSection.appendChild(makeText("Overarching Themes", 18, BODY_TEXT_COLOR, true, undefined, "Themes Heading"));
  for (const theme of content.themes) {
    themesSection.appendChild(makeText(`•  ${theme}`, 13, BODY_TEXT_COLOR, false, 788));
  }
  root.appendChild(themesSection);

  const recsSection = figma.createFrame();
  recsSection.name = "Recommendations Section";
  recsSection.layoutMode = "VERTICAL";
  recsSection.primaryAxisSizingMode = "AUTO";
  recsSection.counterAxisSizingMode = "AUTO";
  recsSection.itemSpacing = 12;
  recsSection.fills = [];
  recsSection.appendChild(makeText("Strategic Recommendations", 18, BODY_TEXT_COLOR, true, undefined, "Recommendations Heading"));
  for (const rec of content.recommendations) {
    recsSection.appendChild(createRecommendationCard(rec));
  }
  root.appendChild(recsSection);

  return root;
}

// Deliberately does not rely on the session-scoped activeSection/
// recommendationsFrame/nextX (all in-memory, lost on every plugin reopen and
// meaningless once a *different* evaluation's section becomes active) — the
// target section, any existing recommendations frame to replace in place,
// and the X position for a new one are all resolved fresh off the canvas
// each time, the same "trust the canvas, not memory" approach already used
// by renumber/refresh-key-fixes/list-pages.
async function buildRecommendations(siteLabel: string, content: RecommendationsContent, sectionId?: string) {
  await loadFonts();
  const section = await resolveTargetSection(sectionId);
  if (!section) throw new Error("Could not find that evaluation on the canvas — refresh the evaluation list and try again.");

  const frames = section.children.filter((c): c is FrameNode => c.type === "FRAME");
  const existing = frames.find((f) => f.getPluginData("heuriRole") === ROLE.recommendations) ?? null;
  const x = existing ? existing.x : frames.length > 0 ? Math.max(...frames.map((f) => f.x + f.width)) + 120 : 0;

  const frame = buildRecommendationsPage(siteLabel, content);
  frame.x = x;
  frame.y = 0;
  figma.currentPage.appendChild(frame);
  section.appendChild(frame);

  if (existing) existing.remove();

  figma.viewport.scrollAndZoomIntoView(section.children);
}

figma.ui.onmessage = async (msg: UiToCodeMessage) => {
  if (msg.type === "load-settings") {
    const settings = (await figma.clientStorage.getAsync("heuri-settings")) as Settings | undefined;
    post({ type: "settings", settings: settings ?? null });
    return;
  }
  if (msg.type === "save-settings") {
    await figma.clientStorage.setAsync("heuri-settings", msg.settings);
    return;
  }
  if (msg.type === "load-session") {
    const session = await figma.clientStorage.getAsync("heuri-session");
    post({ type: "session", session: session ?? null });
    return;
  }
  if (msg.type === "save-session") {
    await figma.clientStorage.setAsync("heuri-session", msg.session);
    return;
  }
  if (msg.type === "start-review") {
    try {
      await ensureSeverityStyles();
      await startReview(msg.siteLabel);
      post({ type: "review-started" });
    } catch (err) {
      post({ type: "build-error", message: String(err) });
    }
    return;
  }
  if (msg.type === "build-page") {
    try {
      const warnings = await buildPage(msg.page);
      post({ type: "page-built", label: msg.page.label, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (err) {
      post({ type: "page-build-error", label: msg.page.label, message: String(err) });
    }
    return;
  }
  if (msg.type === "finish-review") {
    finishReview();
    post({ type: "build-complete" });
    return;
  }
  if (msg.type === "renumber") {
    const root = getSelectedPageRoot();
    if (!root) {
      post({ type: "command-result", command: "renumber", ok: false, message: "Select a page (or anything inside it) on the canvas first." });
      return;
    }
    try {
      const count = await renumberPage(root);
      post({ type: "command-result", command: "renumber", ok: true, message: `Renumbered ${count} pin(s) on "${root.name}".` });
    } catch (err) {
      post({ type: "command-result", command: "renumber", ok: false, message: String(err) });
    }
    return;
  }
  if (msg.type === "refresh-key-fixes") {
    const root = getSelectedPageRoot();
    if (!root) {
      post({ type: "command-result", command: "refresh-key-fixes", ok: false, message: "Select a page (or anything inside it) on the canvas first." });
      return;
    }
    try {
      const count = await refreshKeyFixes(root);
      post({
        type: "command-result",
        command: "refresh-key-fixes",
        ok: true,
        message: count > 0 ? `Key Fixes updated for "${root.name}" (${count} item(s)).` : `Key Fixes cleared for "${root.name}" — no "needs-fix" comments found.`,
      });
    } catch (err) {
      post({ type: "command-result", command: "refresh-key-fixes", ok: false, message: String(err) });
    }
    return;
  }
  if (msg.type === "undo-last-comment") {
    if (!lastComment) {
      post({ type: "command-result", command: "undo-last-comment", ok: false, message: "Nothing to undo." });
      return;
    }
    const { pinId, cardId, pageRootId } = lastComment;
    lastComment = null;
    try {
      const pin = await figma.getNodeByIdAsync(pinId);
      const card = await figma.getNodeByIdAsync(cardId);
      const pageRoot = await figma.getNodeByIdAsync(pageRootId);
      if (pin && "remove" in pin) removeWithConnectors(pin as SceneNode);
      if (card && "remove" in card) removeWithConnectors(card as SceneNode);
      const count = pageRoot && pageRoot.type === "FRAME" ? await renumberPage(pageRoot) : 0;
      post({ type: "command-result", command: "undo-last-comment", ok: true, message: `Removed the last comment${count ? ` — ${count} pin(s) remain.` : "."}` });
    } catch (err) {
      post({ type: "command-result", command: "undo-last-comment", ok: false, message: String(err) });
    }
    return;
  }
  if (msg.type === "bulk-delete-comments") {
    const pairs = resolvePinCardPairs(figma.currentPage.selection);
    if (pairs.length === 0) {
      post({ type: "command-result", command: "bulk-delete-comments", ok: false, message: "Select one or more pins/comment cards on the canvas first." });
      return;
    }
    const pageRoots = new Map<string, FrameNode>();
    for (const { pin, card, pageRoot } of pairs) {
      pageRoots.set(pageRoot.id, pageRoot);
      removeWithConnectors(pin);
      removeWithConnectors(card);
    }
    let totalRemaining = 0;
    for (const root of pageRoots.values()) totalRemaining += await renumberPage(root);
    post({ type: "command-result", command: "bulk-delete-comments", ok: true, message: `Deleted ${pairs.length} comment(s); ${totalRemaining} remain across ${pageRoots.size} page(s).` });
    return;
  }
  if (msg.type === "bulk-set-severity") {
    const pairs = resolvePinCardPairs(figma.currentPage.selection);
    if (pairs.length === 0) {
      post({ type: "command-result", command: "bulk-set-severity", ok: false, message: "Select one or more pins/comment cards on the canvas first." });
      return;
    }
    try {
      await loadFonts();
      await ensureSeverityStyles();
      for (const { pin, card } of pairs) {
        applySeverity(pin, card, msg.severity);
      }
      post({ type: "command-result", command: "bulk-set-severity", ok: true, message: `Updated severity for ${pairs.length} comment(s).` });
    } catch (err) {
      post({ type: "command-result", command: "bulk-set-severity", ok: false, message: String(err) });
    }
    return;
  }
  if (msg.type === "toggle-resolved") {
    const pairs = resolvePinCardPairs(figma.currentPage.selection);
    if (pairs.length === 0) {
      post({ type: "command-result", command: "toggle-resolved", ok: false, message: "Select one or more pins/comment cards on the canvas first." });
      return;
    }
    for (const { card } of pairs) {
      setCardResolved(card, card.getPluginData("resolved") !== "true");
    }
    post({ type: "command-result", command: "toggle-resolved", ok: true, message: `Toggled resolved state for ${pairs.length} comment(s).` });
    return;
  }
  if (msg.type === "set-assignee") {
    const pairs = resolvePinCardPairs(figma.currentPage.selection);
    if (pairs.length === 0) {
      post({ type: "command-result", command: "set-assignee", ok: false, message: "Select one or more pins/comment cards on the canvas first." });
      return;
    }
    await loadFonts();
    for (const { card } of pairs) {
      card.setPluginData("assignee", msg.assignee);
      // The "Assignee" text layer always exists in the Card component (see
      // components.ts) — hidden by default; auto-layout skips invisible
      // children, so toggling visibility is enough, no need to add/remove
      // the layer itself.
      const assigneeNode = card.findOne((n) => n.name === "Assignee" && n.type === "TEXT") as TextNode | null;
      if (assigneeNode) {
        assigneeNode.visible = Boolean(msg.assignee);
        if (msg.assignee) assigneeNode.characters = `Assigned to: ${msg.assignee}`;
      }
    }
    post({ type: "command-result", command: "set-assignee", ok: true, message: `Set assignee for ${pairs.length} comment(s).` });
    return;
  }
  if (msg.type === "collect-findings") {
    post({ type: "findings-collected", findings: await collectFindings(msg.sectionId) });
    return;
  }
  if (msg.type === "list-pages") {
    // Scans the whole page fresh (not the session-scoped activeSection/
    // pageFrames state) so this still works after reopening the plugin
    // without re-running a review — same "trust the canvas, not memory"
    // philosophy as renumber/refresh-key-fixes.
    const roots = figma.currentPage.findAll((n) => n.type === "FRAME" && n.getPluginData("heuriRole") === ROLE.pageRoot) as FrameNode[];
    post({ type: "pages-listed", pages: roots.map((r) => ({ id: r.id, name: r.getPluginData("pageLabel") || r.name })) });
    return;
  }
  if (msg.type === "list-sections") {
    // Each evaluation run lives in its own Section (startReview). Scanned
    // fresh off the canvas, same as list-pages — not the session-scoped
    // activeSection, which only ever points at whichever evaluation was
    // most recently started and is lost entirely on reopening the plugin.
    // This is what lets "Refresh review status" / "Generate final
    // recommendations" reach back into a previous, already-completed
    // evaluation instead of only ever seeing the current session's.
    const sections = figma.currentPage.findAll(
      (n) => n.type === "SECTION" && n.getPluginData("heuriRole") === ROLE.evaluationSection
    ) as SectionNode[];
    post({ type: "sections-listed", sections: sections.map((s) => ({ id: s.id, name: s.name })) });
    return;
  }
  if (msg.type === "jump-to-page") {
    const node = await figma.getNodeByIdAsync(msg.id);
    if (!node || !("x" in node)) {
      figma.notify("That page no longer exists — refresh the page list.", { error: true });
      return;
    }
    figma.currentPage.selection = [node as SceneNode];
    figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    return;
  }
  if (msg.type === "build-recommendations") {
    try {
      await buildRecommendations(msg.siteLabel, msg.content, msg.sectionId);
      post({ type: "recommendations-built" });
    } catch (err) {
      post({ type: "recommendations-build-error", message: String(err) });
    }
    return;
  }
  if (msg.type === "log") {
    console.log("[heuri-ui]", msg.message);
  }
};

// Figma plugins have no "click anywhere on the canvas" event — raw click
// coordinates are a Widgets-only capability. The closest real equivalent is
// dragging an element from the plugin UI onto the canvas, which fires this
// with true absoluteX/absoluteY canvas coordinates (see the drag handle in
// ui.ts/ui.html). Whichever tile the drop lands on gets a new pin at the
// exact drop position; renumberPage() then re-sorts the whole page into
// correct reading order so the new comment slots in where it belongs rather
// than just tacking on the next number at the end.
// Single-level undo for the drag-to-place flow below — "I just mis-dropped
// one," not a general undo stack. Cleared after any undo attempt (success or
// the node already being gone, e.g. the designer manually deleted it).
let lastComment: { pinId: string; cardId: string; pageRootId: string } | null = null;

async function handleCommentDrop(rawData: string, dropNode: BaseNode | null, absoluteX: number, absoluteY: number) {
  let payload: { severity: Severity; heuristic: string; title: string; description: string; assignee?: string };
  try {
    payload = JSON.parse(rawData);
  } catch {
    post({ type: "command-result", command: "add-comment", ok: false, message: "Could not read the dropped comment data." });
    return;
  }

  const context = findTileContext(dropNode);
  if (!context) {
    post({ type: "command-result", command: "add-comment", ok: false, message: "Drop the dot directly on a screenshot." });
    return;
  }
  const { tile, cardColumn, pageRoot, section } = context;

  const localX = absoluteX - tile.absoluteTransform[0][2];
  const localY = absoluteY - tile.absoluteTransform[1][2];
  const x_pct = Math.min(100, Math.max(0, (localX / tile.width) * 100));
  const y_pct = Math.min(100, Math.max(0, (localY / tile.height) * 100));

  try {
    await loadFonts();
    await ensureSeverityStyles();
    const number = getNextPinNumber(pageRoot);
    const pin = await createPin(number, payload.severity, (x_pct / 100) * tile.width, (y_pct / 100) * tile.height);
    tile.appendChild(pin);
    const card = await createAnnotationCard(number, payload.severity, {
      x_pct,
      y_pct,
      severity: payload.severity,
      heuristic: payload.heuristic || "Manual addition",
      title: payload.title,
      description: payload.description,
      assignee: payload.assignee || undefined,
    });
    cardColumn.appendChild(card);
    createConnectorForPair(pin, card, payload.severity, section);
    const finalCount = await renumberPage(pageRoot);
    lastComment = { pinId: pin.id, cardId: card.id, pageRootId: pageRoot.id };
    post({
      type: "command-result",
      command: "add-comment",
      ok: true,
      message: `Added comment to "${tile.name}" — renumbered (${finalCount} pin(s) on this page).`,
    });
  } catch (err) {
    post({ type: "command-result", command: "add-comment", ok: false, message: String(err) });
  }
}

figma.on("drop", (event) => {
  const item = event.items.find((i) => i.type === "application/x-heuri-comment");
  if (!item) return true;
  handleCommentDrop(item.data, event.node, event.absoluteX, event.absoluteY);
  return false;
});
