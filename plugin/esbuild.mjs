import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

async function buildUi() {
  const result = await build({
    entryPoints: ["src/ui.ts"],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2020",
  });
  const script = result.outputFiles[0].text;
  const html = readFileSync("src/ui.html", "utf8").replace("__UI_SCRIPT__", () => script);
  writeFileSync("dist/ui.html", html);
}

async function buildCode() {
  await build({
    entryPoints: ["src/code.ts"],
    bundle: true,
    outfile: "dist/code.js",
    format: "iife",
    target: "es2020",
  });
}

async function run() {
  await Promise.all([buildUi(), buildCode()]);
  console.log("built plugin/dist");
}

if (watch) {
  const ctxUi = await context({
    entryPoints: ["src/ui.ts"],
    bundle: true,
    outdir: "dist/.tmp-ui",
    format: "iife",
    target: "es2020",
    plugins: [{ name: "rebuild-html", setup(b) { b.onEnd(buildUi); } }],
  });
  const ctxCode = await context({
    entryPoints: ["src/code.ts"],
    bundle: true,
    outfile: "dist/code.js",
    format: "iife",
    target: "es2020",
  });
  await Promise.all([ctxUi.watch(), ctxCode.watch()]);
  await buildUi();
  console.log("watching plugin/src for changes…");
} else {
  await run();
}
