import { chromium } from "playwright";
import sharp from "sharp";
import { putTile } from "./store.js";
import { config } from "./config.js";
import { assertPublicHttpUrl } from "./security.js";

export type Viewport = "desktop" | "mobile";

const VIEWPORTS: Record<Viewport, { width: number; height: number; tileHeight: number }> = {
  desktop: { width: 1440, height: 900, tileHeight: 1400 },
  mobile: { width: 390, height: 844, tileHeight: 1400 },
};

// Common selectors to locate a page's global nav/header and footer for
// dedicated component capture — tried in order, first match wins. Falls back
// to class-based heuristics since many sites don't use semantic <footer>.
export const COMPONENT_SELECTORS: Record<"header" | "footer", string[]> = {
  header: ["header", "nav", "[class*='header']", "[class*='navbar']", "[id*='header']"],
  footer: ["footer", "[class*='footer']", "[id*='footer']"],
};

export interface ScanTile {
  id: string;
  url: string;
  width: number;
  height: number;
  offsetY: number;
  pageWidth: number;
  pageHeight: number;
}

export interface ScanResult {
  pageUrl: string;
  viewport: Viewport;
  tiles: ScanTile[];
}

async function tileImageBuffer(buffer: Buffer, tileHeight: number): Promise<ScanTile[]> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const tiles: ScanTile[] = [];
  let offsetY = 0;
  while (offsetY < height) {
    const sliceHeight = Math.min(tileHeight, height - offsetY);
    const sliceBuffer = await sharp(buffer)
      .extract({ left: 0, top: offsetY, width, height: sliceHeight })
      .png()
      .toBuffer();
    const id = putTile(sliceBuffer, "image/png");
    tiles.push({
      id,
      url: `${config.publicBaseUrl}/tiles/${id}`,
      width,
      height: sliceHeight,
      offsetY,
      pageWidth: width,
      pageHeight: height,
    });
    offsetY += sliceHeight;
  }
  return tiles;
}

export async function captureFullPage(pageUrl: string, viewport: Viewport): Promise<ScanResult> {
  await assertPublicHttpUrl(pageUrl);
  const vp = VIEWPORTS[viewport];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    // "load" rather than "networkidle" — real sites with persistent
    // background activity (chat widgets, analytics beacons, ad trackers)
    // never go fully idle, which made networkidle slow and occasionally
    // eat the full 30s timeout per page for no benefit to the screenshot.
    await page.goto(pageUrl, { waitUntil: "load", timeout: 30_000 });

    const fullPageBuffer = await page.screenshot({ fullPage: true, type: "png" });
    const tiles = await tileImageBuffer(fullPageBuffer, vp.tileHeight);

    return { pageUrl, viewport, tiles };
  } finally {
    await browser.close();
  }
}

// Captures a specific page element (site nav/header or footer) rather than
// the full page, so it can be reviewed as its own dedicated "page" in the
// output — matching how these get their own standalone evaluation in the
// reference heuristic decks, independent of whichever content pages are
// selected for review. Returns null if no matching element is found.
export async function captureComponent(
  pageUrl: string,
  kind: "header" | "footer",
  viewport: Viewport
): Promise<ScanResult | null> {
  await assertPublicHttpUrl(pageUrl);
  const vp = VIEWPORTS[viewport];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    // "load" rather than "networkidle" — real sites with persistent
    // background activity (chat widgets, analytics beacons, ad trackers)
    // never go fully idle, which made networkidle slow and occasionally
    // eat the full 30s timeout per page for no benefit to the screenshot.
    await page.goto(pageUrl, { waitUntil: "load", timeout: 30_000 });

    let elementBuffer: Buffer | null = null;
    for (const selector of COMPONENT_SELECTORS[kind]) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) {
        try {
          elementBuffer = await locator.screenshot({ type: "png", timeout: 10_000 });
          break;
        } catch {
          continue;
        }
      }
    }
    if (!elementBuffer) return null;

    const tiles = await tileImageBuffer(elementBuffer, vp.tileHeight);
    return { pageUrl, viewport, tiles };
  } finally {
    await browser.close();
  }
}
