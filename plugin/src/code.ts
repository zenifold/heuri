/// <reference types="@figma/plugin-typings" />
import type { Annotation, CodeToUiMessage, PageResult, Settings, UiToCodeMessage } from "./types";
import { loadFonts, HEADER_BAND_COLOR, PAGE_BG_COLOR, BODY_TEXT_COLOR, FONT, FONT_BOLD } from "./theme";
import { buildViewportSection, createAnnotationCard, createPin, DESKTOP_DISPLAY_SCALE, MOBILE_DISPLAY_SCALE, ROLE } from "./components";

figma.showUI(__html__, { width: 440, height: 760 });

function post(message: CodeToUiMessage) {
  figma.ui.postMessage(message);
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
      "AI-assisted heuristic first pass. Review, edit, and approve findings below.",
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

async function startReview(siteLabel: string) {
  await loadFonts();
  activeSection = figma.createSection();
  activeSection.name = `${siteLabel} — Heuristic Review`;
  nextX = 0;
  pageFrames.clear();
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

function findBadgeNumberText(pinOrCard: FrameNode): TextNode | null {
  const found = pinOrCard.findOne((n) => n.name === "badge-number" && n.type === "TEXT");
  return (found as TextNode) ?? null;
}

// Renumbers pins and their matching comment cards in reading order (each
// tile top-to-bottom within Desktop, then Mobile; pins within a tile ordered
// top-to-bottom, left-to-right) — closing gaps left behind after a designer
// deletes or adds cards during review.
async function renumberPage(root: FrameNode): Promise<number> {
  await loadFonts();

  const pins = root.findAll((n) => n.getPluginData("heuriRole") === ROLE.pin) as FrameNode[];
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

  const cardsByOldNumber = new Map<number, FrameNode>();
  for (const card of root.findAll((n) => n.getPluginData("heuriRole") === ROLE.card) as FrameNode[]) {
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
  const pins = root.findAll((n) => n.getPluginData("heuriRole") === ROLE.pin) as FrameNode[];
  let max = 0;
  for (const pin of pins) {
    const numText = findBadgeNumberText(pin);
    const n = numText ? parseInt(numText.characters, 10) : NaN;
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

// Locates the screenshot tile the designer has selected (or has something
// selected inside), plus that viewport's comment column and the enclosing
// page — so "Add comment" can drop a new pin onto the right image and a new
// card into the right column, without the designer needing to navigate the
// layer tree themselves.
function getSelectedTileContext(): { tile: FrameNode; cardColumn: FrameNode; pageRoot: FrameNode } | null {
  const [selected] = figma.currentPage.selection;
  if (!selected) return null;

  let tile: FrameNode | null = null;
  let current: BaseNode | null = selected;
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

  return { tile, cardColumn, pageRoot };
}

// Recomputes the Key Fixes summary from whatever comment cards currently
// exist on the canvas — i.e. after the designer has edited, added, or
// removed AI suggestions — rather than the AI's original (now possibly
// stale) output.
async function refreshKeyFixes(root: FrameNode): Promise<number> {
  await loadFonts();

  const list = root.findOne((n) => n.getPluginData("heuriRole") === ROLE.keyFixesList) as FrameNode | null;
  if (!list) throw new Error("Could not find the Key Fixes list on this page.");

  const cards = root.findAll((n) => n.getPluginData("heuriRole") === ROLE.card) as FrameNode[];
  const fixes = cards
    .filter((c) => c.getPluginData("severity") === "needs-fix")
    .slice(0, 4)
    .map((c) => c.getPluginData("title") || "Untitled finding");

  populateKeyFixesList(list, fixes);
  return fixes.length;
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
  if (msg.type === "add-comment") {
    const target = getSelectedTileContext();
    if (!target) {
      post({
        type: "command-result",
        command: "add-comment",
        ok: false,
        message: "Select a screenshot on the canvas first (click directly on one of the page images, not the page frame itself).",
      });
      return;
    }
    try {
      await loadFonts();
      const { tile, cardColumn, pageRoot } = target;
      const number = getNextPinNumber(pageRoot);
      const pin = createPin(number, msg.severity, tile.width / 2, tile.height / 2);
      tile.appendChild(pin);
      cardColumn.appendChild(
        createAnnotationCard(number, msg.severity, {
          x_pct: 50,
          y_pct: 50,
          severity: msg.severity,
          heuristic: msg.heuristic || "Manual addition",
          title: msg.title,
          description: msg.description,
        })
      );
      post({
        type: "command-result",
        command: "add-comment",
        ok: true,
        message: `Added comment ${String(number).padStart(2, "0")} to the center of the screenshot — drag the pin into position.`,
      });
    } catch (err) {
      post({ type: "command-result", command: "add-comment", ok: false, message: String(err) });
    }
    return;
  }
  if (msg.type === "log") {
    console.log("[heuri-ui]", msg.message);
  }
};
