import type { Annotation, CodeToUiMessage, PageResult, Settings, TileWithAnnotations, UiToCodeMessage } from "./types";

interface DiscoveredPage {
  url: string;
  label: string;
  source: "sitemap" | "nav";
}

interface ScanTileDto {
  id: string;
  url: string;
  width: number;
  height: number;
  offsetY: number;
  pageWidth: number;
  pageHeight: number;
}

interface ScanResultDto {
  label: string;
  pageUrl: string;
  viewport: "desktop" | "mobile";
  tiles: ScanTileDto[];
  error?: string;
}

interface CapturedPage {
  label: string;
  url: string;
  desktop: ScanResultDto | null;
  mobile: ScanResultDto | null;
  checked: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const backendUrlInput = $<HTMLInputElement>("backend-url");
const sharedSecretInput = $<HTMLInputElement>("shared-secret");
const siteUrlInput = $<HTMLInputElement>("site-url");
const pagesList = $<HTMLDivElement>("pages-list");
const pagesEmptyHint = $<HTMLDivElement>("pages-empty-hint");
const selectAllRow = $<HTMLDivElement>("select-all-row");
const selectAllCheckbox = $<HTMLInputElement>("select-all");
const selectedCountEl = $<HTMLSpanElement>("selected-count");
const manualUrlInput = $<HTMLTextAreaElement>("manual-url");
const logEl = $<HTMLDivElement>("log");
const statusEl = $<HTMLDivElement>("status");
const captureBtn = $<HTMLButtonElement>("capture-btn");
const captureSpinner = $<HTMLSpanElement>("capture-spinner");
const analyzeBtn = $<HTMLButtonElement>("analyze-btn");
const analyzeSpinner = $<HTMLSpanElement>("analyze-spinner");
const cancelBtn = $<HTMLButtonElement>("cancel-btn");
const discoverBtn = $<HTMLButtonElement>("discover-btn");
const progressWrap = $<HTMLDivElement>("progress-wrap");
const progressFill = $<HTMLDivElement>("progress-fill");
const progressText = $<HTMLDivElement>("progress-text");
const analyzeList = $<HTMLDivElement>("analyze-list");
const analyzeEmptyHint = $<HTMLDivElement>("analyze-empty-hint");
const analyzeSelectAllRow = $<HTMLDivElement>("analyze-select-all-row");
const analyzeSelectAllCheckbox = $<HTMLInputElement>("analyze-select-all");
const analyzeSelectedCountEl = $<HTMLSpanElement>("analyze-selected-count");
const renumberBtn = $<HTMLButtonElement>("renumber-btn");
const refreshKeyFixesBtn = $<HTMLButtonElement>("refresh-key-fixes-btn");
const commentSeverity = $<HTMLSelectElement>("comment-severity");
const commentHeuristic = $<HTMLInputElement>("comment-heuristic");
const commentTitle = $<HTMLInputElement>("comment-title");
const commentDescription = $<HTMLTextAreaElement>("comment-description");
const addCommentBtn = $<HTMLButtonElement>("add-comment-btn");
const testAiBtn = $<HTMLButtonElement>("test-ai-btn");
const testAiSpinner = $<HTMLSpanElement>("test-ai-spinner");
const testAiResult = $<HTMLDivElement>("test-ai-result");
const resetPluginBtn = $<HTMLButtonElement>("reset-plugin-btn");

interface SessionState {
  siteUrl: string;
  pages: { url: string; label: string; checked: boolean }[];
  captured: CapturedPage[];
  savedAt: number;
}

let pages: { url: string; label: string; checked: boolean }[] = [];
let captured: CapturedPage[] = [];
let cancelled = false;
let controller: AbortController | null = null;
let currentPhase: "capture" | "analyze" | null = null;
let restoringSession = false;

// Persists the page list / capture results so closing and reopening the
// plugin panel mid-review doesn't lose everything — a capture/analyze run
// can take several minutes across many pages, and the panel can close from
// an accidental click as easily as intentionally.
function persistSession() {
  if (restoringSession) return;
  const session: SessionState = { siteUrl: siteUrlInput.value, pages, captured, savedAt: Date.now() };
  send({ type: "save-session", session });
}

function send(message: UiToCodeMessage) {
  parent.postMessage({ pluginMessage: message }, "*");
}

function log(message: string) {
  logEl.textContent += message + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

// Serializes page builds: code.ts's message handler is async with several
// await points (image loading in particular), and figma.ui.onmessage
// invocations for back-to-back messages can interleave at those await
// points. Firing every "build-page" message in a tight loop without waiting
// let multiple builds race on the same shared "next X position" state,
// landing pages on top of each other. Awaiting each one's page-built /
// page-build-error response before sending the next closes that race.
let pendingPageBuildResolve: ((result: { ok: boolean; message?: string }) => void) | null = null;
let pendingReviewStartedResolve: (() => void) | null = null;

function sendBuildPageAndWait(page: PageResult): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    pendingPageBuildResolve = resolve;
    send({ type: "build-page", page });
  });
}

function sendStartReviewAndWait(siteLabel: string): Promise<void> {
  return new Promise((resolve) => {
    pendingReviewStartedResolve = resolve;
    send({ type: "start-review", siteLabel });
  });
}

function setStatus(message: string, kind: "ok" | "error" | "" = "") {
  statusEl.textContent = message;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function setProgress(fraction: number | null, text: string) {
  progressWrap.style.display = "block";
  progressFill.style.width = fraction === null ? "8%" : `${Math.round(fraction * 100)}%`;
  progressText.textContent = text;
}

function hideProgress() {
  progressWrap.style.display = "none";
}

const MAX_PAGES_PER_RUN = 10;

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("AbortError") || msg.toLowerCase().includes("abort")) return "Cancelled.";
  if (msg.includes("401")) return "Invalid shared secret — check Backend settings.";
  if (msg.includes("429")) return "Rate limited by the AI provider — wait a moment or scan fewer pages at once.";
  if (msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("networkerror")) {
    return "Could not reach the backend — check the Backend URL in settings and that it's running.";
  }
  if (msg.includes("too_big") && msg.includes("pages")) {
    return `Too many pages selected — max ${MAX_PAGES_PER_RUN} per run. Uncheck some pages below.`;
  }
  return msg;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function updateSelectedCount() {
  const count = pages.filter((p) => p.checked).length;
  selectedCountEl.textContent = `${count} selected (max ${MAX_PAGES_PER_RUN})`;
  selectedCountEl.style.color = count > MAX_PAGES_PER_RUN ? "#b91c1c" : "#71717a";
}

function renderPages() {
  pagesList.innerHTML = "";
  pagesEmptyHint.style.display = pages.length === 0 ? "block" : "none";
  selectAllRow.style.display = pages.length === 0 ? "none" : "flex";
  selectAllCheckbox.checked = pages.length > 0 && pages.every((p) => p.checked);
  updateSelectedCount();

  pages.forEach((page, i) => {
    const row = document.createElement("div");
    row.className = "page-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = page.checked;
    checkbox.onchange = () => {
      pages[i].checked = checkbox.checked;
      selectAllCheckbox.checked = pages.every((p) => p.checked);
      updateSelectedCount();
      persistSession();
    };

    const label = document.createElement("input");
    label.type = "text";
    label.value = page.label;
    label.style.width = "90px";
    label.onchange = () => {
      pages[i].label = label.value;
      persistSession();
    };

    const url = document.createElement("input");
    url.type = "text";
    url.value = page.url;
    url.style.flex = "1";
    url.onchange = () => {
      pages[i].url = url.value;
      persistSession();
    };

    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.textContent = "×";
    remove.style.padding = "4px 8px";
    remove.style.marginBottom = "0";
    remove.onclick = () => {
      pages.splice(i, 1);
      renderPages();
    };

    row.append(checkbox, label, url, remove);
    pagesList.appendChild(row);
  });

  persistSession();
}

selectAllCheckbox.onchange = () => {
  pages.forEach((p) => (p.checked = selectAllCheckbox.checked));
  renderPages();
};

function updateAnalyzeSelectedCount() {
  const count = captured.filter((c) => c.checked).length;
  analyzeSelectedCountEl.textContent = `${count} selected`;
}

function renderAnalyzeList() {
  analyzeList.innerHTML = "";
  const hasCaptured = captured.length > 0;
  analyzeEmptyHint.style.display = hasCaptured ? "none" : "block";
  analyzeSelectAllRow.style.display = hasCaptured ? "flex" : "none";
  analyzeSelectAllCheckbox.checked = hasCaptured && captured.every((c) => c.checked);
  analyzeBtn.disabled = !hasCaptured;
  updateAnalyzeSelectedCount();

  captured.forEach((page, i) => {
    const row = document.createElement("div");
    row.className = "page-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = page.checked;
    checkbox.onchange = () => {
      captured[i].checked = checkbox.checked;
      analyzeSelectAllCheckbox.checked = captured.every((c) => c.checked);
      updateAnalyzeSelectedCount();
      persistSession();
    };

    const label = document.createElement("span");
    label.style.flex = "1";
    label.textContent = page.label;

    const meta = document.createElement("span");
    meta.style.fontSize = "10px";
    meta.style.color = "#71717a";
    const parts: string[] = [];
    if (page.desktop) parts.push(`desktop: ${page.desktop.tiles.length} tile(s)`);
    if (page.mobile) parts.push(`mobile: ${page.mobile.tiles.length} tile(s)`);
    meta.textContent = parts.join(", ");

    row.append(checkbox, label, meta);
    analyzeList.appendChild(row);
  });

  persistSession();
}

analyzeSelectAllCheckbox.onchange = () => {
  captured.forEach((c) => (c.checked = analyzeSelectAllCheckbox.checked));
  renderAnalyzeList();
};

function backendHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-heuri-secret": sharedSecretInput.value,
  };
}

function backendUrl(path: string): string {
  return backendUrlInput.value.replace(/\/+$/, "") + path;
}

function markFieldValidity(el: HTMLInputElement, valid: boolean) {
  el.classList.toggle("field-error", !valid);
}

function validateBackendSettings(): boolean {
  const urlOk = backendUrlInput.value.trim().length > 0;
  const secretOk = sharedSecretInput.value.trim().length > 0;
  markFieldValidity(backendUrlInput, urlOk);
  markFieldValidity(sharedSecretInput, secretOk);
  if (!urlOk || !secretOk) {
    $<HTMLDetailsElement>("settings-details").open = true;
    setStatus("Fill in the Backend URL and shared secret first.", "error");
    return false;
  }
  return true;
}

$<HTMLButtonElement>("save-settings").onclick = () => {
  const settings: Settings = { backendUrl: backendUrlInput.value, sharedSecret: sharedSecretInput.value };
  send({ type: "save-settings", settings });
  markFieldValidity(backendUrlInput, true);
  markFieldValidity(sharedSecretInput, true);
  setStatus("Settings saved.", "ok");
};

interface TestAiResponse {
  ok: boolean;
  provider: string;
  model?: string;
  elapsedMs: number;
  findingCount?: number;
  sample?: { title: string; severity: string } | null;
  error?: string;
}

// Exercises the real capture -> analyze path against a small, fast test page
// (not the user's site) so they can confirm the configured AI provider
// actually works and see genuine sample output before running a real scan.
testAiBtn.onclick = async () => {
  if (!validateBackendSettings()) return;
  testAiBtn.disabled = true;
  testAiSpinner.style.display = "inline-block";
  testAiResult.textContent = "Testing… (captures a page and runs one AI analysis, ~5-10s)";
  testAiResult.style.color = "#71717a";
  try {
    const res = await fetch(backendUrl("/test-ai"), { method: "POST", headers: backendHeaders() });
    const data = (await res.json()) as TestAiResponse;
    const modelPart = data.model ? ` (${data.model})` : "";
    if (data.ok) {
      const samplePart = data.sample ? ` Sample: "${data.sample.title}" [${data.sample.severity}].` : "";
      testAiResult.textContent = `✓ Connected via ${data.provider}${modelPart} — ${data.findingCount} finding(s) in ${(data.elapsedMs / 1000).toFixed(1)}s.${samplePart}`;
      testAiResult.style.color = "#15803d";
    } else {
      testAiResult.textContent = `⚠ ${data.provider}${modelPart}: ${friendlyError(data.error)}`;
      testAiResult.style.color = "#b91c1c";
    }
  } catch (err) {
    testAiResult.textContent = `⚠ ${friendlyError(err)}`;
    testAiResult.style.color = "#b91c1c";
  } finally {
    testAiBtn.disabled = false;
    testAiSpinner.style.display = "none";
  }
};

$<HTMLButtonElement>("clear-site-btn").onclick = () => {
  pages = [];
  captured = [];
  siteUrlInput.value = "";
  logEl.textContent = "";
  hideProgress();
  setStatus("");
  renderPages();
  renderAnalyzeList();
};

// Full reset: clears page list, captured screenshots, and saved session, and
// forces every button/spinner back to an idle state — for when the panel
// gets stuck mid-operation (a hung request, an unresolved promise) or the
// designer just wants to start over on a different site. Backend URL and
// shared secret are left untouched since retyping those is the annoying part.
resetPluginBtn.onclick = () => {
  cancelled = true;
  controller?.abort();
  controller = null;
  currentPhase = null;
  pendingPageBuildResolve = null;
  pendingReviewStartedResolve = null;

  pages = [];
  captured = [];
  siteUrlInput.value = "";
  manualUrlInput.value = "";
  commentTitle.value = "";
  commentDescription.value = "";
  commentHeuristic.value = "";
  logEl.textContent = "";

  setRunningState(false);
  hideProgress();
  renderPages();
  renderAnalyzeList();
  setStatus("Plugin reset — page list and captured screenshots cleared.", "ok");
};

function labelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? last.replace(/[-_]/g, " ") : "Home";
  } catch {
    return "Page";
  }
}

$<HTMLButtonElement>("add-page-btn").onclick = () => {
  const raw = manualUrlInput.value;
  const urls = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls.length === 0) return;
  const existing = new Set(pages.map((p) => p.url));
  let added = 0;
  for (const url of urls) {
    if (existing.has(url)) continue;
    pages.push({ url, label: labelFromUrl(url), checked: true });
    existing.add(url);
    added += 1;
  }
  manualUrlInput.value = "";
  renderPages();
  if (added < urls.length) {
    setStatus(`Added ${added} page(s); ${urls.length - added} were already in the list.`, "");
  }
};

discoverBtn.onclick = async () => {
  const siteUrl = siteUrlInput.value.trim();
  if (!siteUrl) {
    setStatus("Enter a site URL first.", "error");
    return;
  }
  if (!validateBackendSettings()) return;

  discoverBtn.disabled = true;
  setStatus("Discovering pages…");
  try {
    const res = await fetch(backendUrl("/discover-pages"), {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({ siteUrl }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { pages: DiscoveredPage[] };
    pages = data.pages.map((p) => ({ url: p.url, label: p.label, checked: true }));
    captured = [];
    renderPages();
    renderAnalyzeList();
    setStatus(
      pages.length > 0
        ? `Found ${pages.length} candidate pages.`
        : "No pages found automatically — add URLs manually below.",
      "ok"
    );
  } catch (err) {
    setStatus(`Discover failed: ${friendlyError(err)}`, "error");
  } finally {
    discoverBtn.disabled = false;
  }
};

async function analyzeTile(imageUrl: string, pageLabel: string, signal: AbortSignal): Promise<Annotation[]> {
  const res = await fetch(backendUrl("/analyze"), {
    method: "POST",
    headers: backendHeaders(),
    body: JSON.stringify({ imageUrl, pageLabel }),
    signal,
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { annotations: Annotation[] };
  return data.annotations;
}

// The plugin main thread's sandbox has no real network access — Figma's own
// guidance is that network requests belong in the UI iframe (a real browser
// context), with results passed to the main thread. Screenshot bytes are
// fetched here, not via figma.createImageAsync(url) in code.ts.
async function fetchImageBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Failed to fetch tile image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

function setRunningState(running: boolean) {
  captureBtn.disabled = running;
  analyzeBtn.disabled = running || captured.length === 0;
  cancelBtn.disabled = !running;
  discoverBtn.disabled = running;
  if (!running) {
    captureSpinner.style.display = "none";
    analyzeSpinner.style.display = "none";
  }
}

cancelBtn.onclick = () => {
  cancelled = true;
  controller?.abort();
  setStatus("Cancelling…");
};

async function tilesWithBytes(result: ScanResultDto, signal: AbortSignal): Promise<TileWithAnnotations[]> {
  const tiles: TileWithAnnotations[] = [];
  for (const t of result.tiles) {
    try {
      const imageBytes = await fetchImageBytes(t.url, signal);
      tiles.push({ imageBytes, width: t.width, height: t.height, annotations: [] });
    } catch (err) {
      if (isAbort(err)) break;
      log(`⚠ Could not load screenshot for ${result.label} (${result.viewport}): ${friendlyError(err)}`);
    }
  }
  return tiles;
}

async function toPageResult(
  page: { label: string; url: string; desktop: ScanResultDto | null; mobile: ScanResultDto | null },
  signal: AbortSignal
): Promise<PageResult> {
  const desktopTiles = page.desktop ? await tilesWithBytes(page.desktop, signal) : [];
  const mobileTiles = page.mobile ? await tilesWithBytes(page.mobile, signal) : [];
  return {
    label: page.label,
    url: page.url,
    desktop: desktopTiles.length > 0 ? { tiles: desktopTiles } : null,
    mobile: mobileTiles.length > 0 ? { tiles: mobileTiles } : null,
  };
}

// Phase 1: capture full-page screenshots and place them on the Figma canvas
// immediately, with the header/title/URL info but no AI annotations yet
// (screenshot-only frames). This also populates the "Pages to analyze"
// checklist below — capture is the slow, Playwright-heavy step, so it runs
// once for everything selected, independent of which pages later get AI
// analysis (which costs per-tile AI calls and can be re-run on a subset).
captureBtn.onclick = async () => {
  const selected = pages.filter((p) => p.checked);
  if (selected.length === 0) {
    setStatus("Select at least one page.", "error");
    return;
  }
  if (selected.length > MAX_PAGES_PER_RUN) {
    setStatus(`Too many pages selected (${selected.length}) — max ${MAX_PAGES_PER_RUN} per run. Uncheck some below.`, "error");
    return;
  }
  const viewports: ("desktop" | "mobile")[] = [];
  if ($<HTMLInputElement>("vp-desktop").checked) viewports.push("desktop");
  if ($<HTMLInputElement>("vp-mobile").checked) viewports.push("mobile");
  if (viewports.length === 0) {
    setStatus("Select at least one viewport.", "error");
    return;
  }
  const components: ("header" | "footer")[] = [];
  if ($<HTMLInputElement>("capture-header").checked) components.push("header");
  if ($<HTMLInputElement>("capture-footer").checked) components.push("footer");
  if (!validateBackendSettings()) return;

  cancelled = false;
  controller = new AbortController();
  currentPhase = "capture";
  setRunningState(true);
  captureSpinner.style.display = "inline-block";
  logEl.textContent = "";
  setStatus("Capturing screenshots…");

  const siteLabel = new URL(selected[0].url).hostname;

  // One /scan call per (page, viewport) — and per (component, viewport) —
  // rather than one giant batched call. This is what actually drives real,
  // incremental progress: a single big request gives zero feedback while
  // it's running (which for 10+ pages × 2 viewports could legitimately take
  // several minutes and just looks frozen), and a single slow/stuck item
  // blocks visibility into everything else queued behind it.
  interface CaptureJob {
    label: string;
    url: string;
    viewport: "desktop" | "mobile";
    component?: "header" | "footer";
  }
  // Header/footer are captured (and later placed in Figma) before the
  // regular content pages — they're the persistent, site-wide UI elements,
  // so reviewing them first matches how these decks are meant to be read.
  const jobs: CaptureJob[] = [];
  for (const component of components) {
    const label = component === "header" ? "Global Navigation (Header)" : "Global Navigation (Footer)";
    for (const viewport of viewports) jobs.push({ label, url: selected[0].url, viewport, component });
  }
  for (const page of selected) {
    for (const viewport of viewports) jobs.push({ label: page.label, url: page.url, viewport });
  }

  const results: ScanResultDto[] = [];
  try {
    for (const [i, job] of jobs.entries()) {
      if (cancelled) break;
      setProgress(i / jobs.length, `Capturing ${job.label} (${job.viewport}) — ${i + 1}/${jobs.length}`);
      try {
        const body: { pages: { url: string; label: string }[]; viewports: string[]; components?: string[]; referenceUrl?: string } = {
          pages: job.component ? [] : [{ url: job.url, label: job.label }],
          viewports: [job.viewport],
        };
        if (job.component) {
          body.components = [job.component];
          body.referenceUrl = job.url;
        }
        const scanRes = await fetch(backendUrl("/scan"), {
          method: "POST",
          headers: backendHeaders(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!scanRes.ok) throw new Error(await scanRes.text());
        const { results: itemResults } = (await scanRes.json()) as { results: ScanResultDto[] };
        results.push(...itemResults);
        for (const r of itemResults) {
          if (r.error) log(`⚠ ${r.label} (${r.viewport}) failed to capture: ${friendlyError(r.error)}`);
          else log(`✓ Captured ${r.label} (${r.viewport}) — ${r.tiles.length} tile(s).`);
        }
      } catch (err) {
        if (isAbort(err)) break;
        log(`⚠ ${job.label} (${job.viewport}) failed to capture: ${friendlyError(err)}`);
      }
    }

    const componentLabels: { label: string; url: string }[] = [];
    if (components.includes("header")) componentLabels.push({ label: "Global Navigation (Header)", url: selected[0].url });
    if (components.includes("footer")) componentLabels.push({ label: "Global Navigation (Footer)", url: selected[0].url });

    captured = [...componentLabels, ...selected]
      .map((p) => {
        const desktop = results.find((r) => r.label === p.label && r.viewport === "desktop" && !r.error && r.tiles.length > 0) ?? null;
        const mobile = results.find((r) => r.label === p.label && r.viewport === "mobile" && !r.error && r.tiles.length > 0) ?? null;
        return { label: p.label, url: p.url, desktop, mobile, checked: true };
      })
      .filter((c) => c.desktop || c.mobile);

    renderAnalyzeList();

    if (captured.length === 0) {
      setStatus("Capture finished, but nothing succeeded — check the log.", "error");
      currentPhase = null;
      setRunningState(false);
      hideProgress();
      return;
    }

    setProgress(0, "Placing screenshots on the canvas…");
    await sendStartReviewAndWait(siteLabel);
    for (const [i, page] of captured.entries()) {
      if (cancelled) break;
      setProgress(i / captured.length, `Placing ${page.label} on the canvas — ${i + 1}/${captured.length}`);
      const pageResult = await toPageResult(page, controller.signal);
      if (!pageResult.desktop && !pageResult.mobile) {
        log(`⚠ Skipped ${page.label} — no screenshots could be loaded.`);
        continue;
      }
      await sendBuildPageAndWait(pageResult);
    }
    send({ type: "finish-review" });
    // status + setRunningState(false) happen once build-complete arrives (see window.onmessage)
  } catch (err) {
    currentPhase = null;
    setRunningState(false);
    hideProgress();
    if (isAbort(err)) setStatus("Cancelled.", "");
    else setStatus(`Capture failed: ${friendlyError(err)}`, "error");
  }
};

// Phase 2: run AI heuristic analysis on the chosen subset of already-captured
// pages, then rebuild each one in place on the canvas (same position) now
// with pins + comment cards added.
analyzeBtn.onclick = async () => {
  const selected = captured.filter((c) => c.checked);
  if (selected.length === 0) {
    setStatus("Select at least one captured page to analyze.", "error");
    return;
  }
  if (!validateBackendSettings()) return;

  cancelled = false;
  controller = new AbortController();
  currentPhase = "analyze";
  setRunningState(true);
  analyzeSpinner.style.display = "inline-block";
  setStatus("Running AI review…");

  try {
    const totalTiles = selected.reduce((sum, c) => sum + (c.desktop?.tiles.length ?? 0) + (c.mobile?.tiles.length ?? 0), 0);
    let doneTiles = 0;
    setProgress(0, `Analyzing 0/${totalTiles} tiles…`);

    for (const page of selected) {
      if (cancelled) break;

      const tilesFor = async (result: ScanResultDto, viewport: "desktop" | "mobile"): Promise<TileWithAnnotations[]> => {
        const tiles: TileWithAnnotations[] = [];
        for (const tile of result.tiles) {
          if (cancelled) break;
          const [imgResult, aiResult] = await Promise.allSettled([
            fetchImageBytes(tile.url, controller!.signal),
            analyzeTile(tile.url, page.label, controller!.signal),
          ]);
          doneTiles += 1;
          setProgress(totalTiles ? doneTiles / totalTiles : 1, `Analyzing ${page.label} (${viewport}) — tile ${doneTiles}/${totalTiles}`);

          if (imgResult.status === "rejected") {
            if (isAbort(imgResult.reason)) break;
            log(`⚠ Could not load screenshot for ${page.label} (${viewport}): ${friendlyError(imgResult.reason)}`);
            continue;
          }
          let annotations: Annotation[] = [];
          if (aiResult.status === "fulfilled") {
            annotations = aiResult.value;
          } else if (!isAbort(aiResult.reason)) {
            log(`⚠ AI analysis failed for ${page.label} (${viewport}) tile @${tile.offsetY}px: ${friendlyError(aiResult.reason)} — keeping screenshot without new findings.`);
          }
          tiles.push({ imageBytes: imgResult.value, width: tile.width, height: tile.height, annotations });
        }
        return tiles;
      };

      const desktopTiles = page.desktop ? await tilesFor(page.desktop, "desktop") : null;
      const mobileTiles = page.mobile && !cancelled ? await tilesFor(page.mobile, "mobile") : null;

      const pageResult: PageResult = {
        label: page.label,
        url: page.url,
        desktop: desktopTiles && desktopTiles.length > 0 ? { tiles: desktopTiles } : null,
        mobile: mobileTiles && mobileTiles.length > 0 ? { tiles: mobileTiles } : null,
      };

      if (pageResult.desktop || pageResult.mobile) {
        await sendBuildPageAndWait(pageResult);
      } else if (!cancelled) {
        log(`⚠ Skipped ${page.label} — no tiles to analyze.`);
      }
    }

    send({ type: "finish-review" });
    // status + setRunningState(false) happen once build-complete arrives (see window.onmessage)
  } catch (err) {
    currentPhase = null;
    setRunningState(false);
    hideProgress();
    if (isAbort(err)) setStatus("Cancelled.", "");
    else setStatus(`AI review failed: ${friendlyError(err)}`, "error");
  }
};

// Post-edit cleanup: operate on whatever page frame the designer currently
// has selected on the canvas, reading the *current* state of its comment
// cards (which may have been edited/added/removed) rather than the original
// AI response.
renumberBtn.onclick = () => send({ type: "renumber" });
refreshKeyFixesBtn.onclick = () => send({ type: "refresh-key-fixes" });

addCommentBtn.onclick = () => {
  const title = commentTitle.value.trim();
  if (!title) {
    setStatus("Add a title for the comment first.", "error");
    return;
  }
  send({
    type: "add-comment",
    severity: commentSeverity.value as Annotation["severity"],
    heuristic: commentHeuristic.value.trim(),
    title,
    description: commentDescription.value.trim(),
  });
};

window.onmessage = (event: MessageEvent) => {
  const msg = event.data.pluginMessage as CodeToUiMessage;
  if (!msg) return;
  if (msg.type === "settings") {
    if (msg.settings) {
      backendUrlInput.value = msg.settings.backendUrl;
      sharedSecretInput.value = msg.settings.sharedSecret;
    } else {
      backendUrlInput.value = "http://localhost:8787";
      $<HTMLDetailsElement>("settings-details").open = true;
    }
  } else if (msg.type === "review-started") {
    pendingReviewStartedResolve?.();
    pendingReviewStartedResolve = null;
  } else if (msg.type === "page-built") {
    log(`✓ Built "${msg.label}" on the canvas.`);
    for (const warning of msg.warnings ?? []) log(`  ⚠ ${warning}`);
    pendingPageBuildResolve?.({ ok: true });
    pendingPageBuildResolve = null;
  } else if (msg.type === "page-build-error") {
    log(`⚠ Failed to build "${msg.label}" in Figma: ${msg.message}`);
    pendingPageBuildResolve?.({ ok: false, message: msg.message });
    pendingPageBuildResolve = null;
  } else if (msg.type === "build-complete") {
    setRunningState(false);
    hideProgress();
    if (cancelled) {
      setStatus("Cancelled — pages built so far were kept.", "");
    } else if (currentPhase === "capture") {
      setStatus(`Captured ${captured.length} page(s) — screenshots placed on canvas. Select pages below to analyze.`, "ok");
    } else {
      setStatus("Done — AI review added to canvas.", "ok");
    }
    currentPhase = null;
  } else if (msg.type === "build-error") {
    setStatus(`Figma build failed: ${msg.message}`, "error");
    currentPhase = null;
    setRunningState(false);
    hideProgress();
  } else if (msg.type === "command-result") {
    setStatus(msg.message, msg.ok ? "ok" : "error");
    log((msg.ok ? "✓ " : "⚠ ") + msg.message);
    if (msg.ok && msg.command === "add-comment") {
      commentTitle.value = "";
      commentDescription.value = "";
    }
  } else if (msg.type === "session") {
    const session = msg.session as SessionState | null;
    if (session && (session.pages?.length > 0 || session.captured?.length > 0)) {
      restoringSession = true;
      siteUrlInput.value = session.siteUrl ?? "";
      pages = session.pages ?? [];
      captured = session.captured ?? [];
      renderPages();
      renderAnalyzeList();
      restoringSession = false;
      const ageMin = Math.round((Date.now() - (session.savedAt ?? 0)) / 60000);
      const staleNote = ageMin > 30 ? ` (from ${ageMin} min ago — screenshots may have expired, re-capture if AI review fails)` : "";
      setStatus(`Restored previous session${staleNote}.`, "");
    }
  }
};

send({ type: "load-settings" });
send({ type: "load-session" });
