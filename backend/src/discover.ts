import { chromium } from "playwright";
import { assertPublicHttpUrl } from "./security.js";

export interface DiscoveredPage {
  url: string;
  label: string;
  source: "sitemap" | "nav";
}

// Capped total matches /scan's MAX_PAGES_PER_SCAN so "Select all" on the
// discovered list never overflows that limit.
const MAX_TOTAL_PAGES = 10;
const MAX_PER_CATEGORY = 2;
const MAX_UNCATEGORIZED_FILLER = 3;

// Ordered by priority: a page matching an earlier category is filed under
// that one even if it also matches a later one.
const CATEGORIES: { name: string; keywords: string[] }[] = [
  { name: "find-a-provider", keywords: ["find-a-doctor", "find-a-provider", "find-doctor", "physician", "provider"] },
  { name: "services", keywords: ["service"] },
  { name: "locations", keywords: ["location"] },
  { name: "appointment", keywords: ["appointment", "schedule"] },
  { name: "patients", keywords: ["patient", "visitor"] },
  { name: "about", keywords: ["about"] },
  { name: "contact", keywords: ["contact"] },
];

async function fetchSitemapUrls(origin: string): Promise<string[]> {
  try {
    const res = await fetch(new URL("/sitemap.xml", origin).toString(), {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const matches = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)];
    return matches.map((m) => m[1]);
  } catch {
    return [];
  }
}

async function scrapeNavLinks(origin: string): Promise<{ url: string; label: string }[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const links = await page.$$eval("nav a[href], header a[href]", (anchors) =>
      anchors.map((a) => {
        // textContent includes text from descendant <style>/<script> tags
        // (common inside inline SVG icons), which garbles the label — strip
        // those nodes from a clone before reading it.
        const clone = a.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script, style").forEach((el) => el.remove());
        const label = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
        return { url: (a as HTMLAnchorElement).href, label };
      })
    );
    return links.filter((l) => l.label.length > 0 && l.label.length < 80);
  } finally {
    await browser.close();
  }
}

function labelFromUrl(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  if (!path) return "Home";
  const last = path.split("/").filter(Boolean).pop() ?? "Home";
  return last
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Categorizes on the nav link's visible text AND its URL — a label like
// "Locations" pointing at a hub page is a much stronger signal than a
// keyword buried in a deep URL path, and catches cases where the URL alone
// (e.g. a numeric slug) wouldn't match anything.
function categorize(url: string, label: string): string | null {
  const haystack = `${label} ${url}`.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some((kw) => haystack.includes(kw))) return cat.name;
  }
  return null;
}

function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 99;
  }
}

export async function discoverPages(siteUrl: string): Promise<DiscoveredPage[]> {
  await assertPublicHttpUrl(siteUrl);
  const origin = new URL(siteUrl).origin;
  const [sitemapUrls, navLinks] = await Promise.all([fetchSitemapUrls(origin), scrapeNavLinks(origin)]);

  const home: DiscoveredPage = { url: origin + "/", label: "Home", source: "nav" };
  const candidates = new Map<string, DiscoveredPage>();

  for (const link of navLinks) {
    try {
      const u = new URL(link.url);
      if (u.origin !== origin) continue;
      const key = u.origin + u.pathname;
      if (key === home.url) continue;
      if (!candidates.has(key)) {
        candidates.set(key, { url: key, label: link.label || labelFromUrl(key), source: "nav" });
      }
    } catch {
      // ignore malformed hrefs
    }
  }

  for (const raw of sitemapUrls) {
    try {
      const u = new URL(raw);
      if (u.origin !== origin) continue;
      const key = u.origin + u.pathname;
      if (key === home.url || candidates.has(key)) continue;
      const label = labelFromUrl(key);
      if (categorize(key, label)) {
        candidates.set(key, { url: key, label, source: "sitemap" });
      }
    } catch {
      // ignore malformed loc entries
    }
  }

  const byCategory = new Map<string, DiscoveredPage[]>();
  const uncategorized: DiscoveredPage[] = [];
  for (const page of candidates.values()) {
    const cat = categorize(page.url, page.label);
    if (cat) {
      const list = byCategory.get(cat) ?? [];
      list.push(page);
      byCategory.set(cat, list);
    } else {
      uncategorized.push(page);
    }
  }

  const selected: DiscoveredPage[] = [home];
  for (const cat of CATEGORIES) {
    const list = (byCategory.get(cat.name) ?? []).sort((a, b) => pathDepth(a.url) - pathDepth(b.url));
    selected.push(...list.slice(0, MAX_PER_CATEGORY));
    if (selected.length >= MAX_TOTAL_PAGES) break;
  }

  if (selected.length < MAX_TOTAL_PAGES) {
    const filler = uncategorized.sort((a, b) => pathDepth(a.url) - pathDepth(b.url)).slice(0, MAX_UNCATEGORIZED_FILLER);
    selected.push(...filler);
  }

  return selected.slice(0, MAX_TOTAL_PAGES);
}
