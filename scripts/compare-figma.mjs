// Compares a rendered page with a Figma capture. Needs a running app (npm run dev) and a capture from
// the Figma MCP. Captures stay in the gitignored .handoff/figma folder because this repository is public.
// Usage: node scripts/compare-figma.mjs <url-path> <capture.png> [threshold] [max-percent]
// An optional crop-height compares only the top of the page, for a screen that is taller on purpose.
// With max-percent, exits 1 if the page size differs or more pixels than that differ.
// A page that is taller on purpose can be judged in aligned parts: SEGMENTS="0-840;1008-1200@-58" compares render rows
// 0-840 with Figma rows 0-840, then render rows 1008-1200 with Figma rows 950-1142 (the @ offset is added to the render row
// to find the Figma row). The result adds `segments`, the pixels differing over those rows only. The size check is skipped.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const [path = "/overview", capture = ".handoff/figma/overview-10-217.png", threshold = "0.1", maxPercent, cropHeight] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:5173";
const out = ".handoff/figma/compare";
mkdirSync(out, { recursive: true });

const figma = PNG.sync.read(readFileSync(capture));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: figma.width, height: figma.height }, deviceScaleFactor: 1, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/Los_Angeles" });
await page.goto(base + path, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`));
const shot = PNG.sync.read(await page.screenshot({ fullPage: true }));
await browser.close();

const width = Math.min(figma.width, shot.width);
const height = Math.min(figma.height, shot.height, cropHeight ? Number(cropHeight) : Infinity);
const crop = (src) => { const dst = new PNG({ width, height }); PNG.bitblt(src, dst, 0, 0, width, height, 0, 0); return dst; };
const a = crop(figma);
const b = crop(shot);
const diff = new PNG({ width, height });
const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: Number(threshold) });
writeFileSync(`${out}/render.png`, PNG.sync.write(shot));
writeFileSync(`${out}/diff.png`, PNG.sync.write(diff));
const pct = +((100 * mismatched) / (width * height)).toFixed(3);
let segments;
if (process.env.SEGMENTS) {
  let bad = 0;
  let area = 0;
  for (const part of process.env.SEGMENTS.split(";")) {
    const [rows, offset = "0"] = part.split("@");
    const [from, to] = rows.split("-").map(Number);
    const h = Math.min(to - from, shot.height - from, figma.height - (from + Number(offset)));
    const cut = (src, y) => { const dst = new PNG({ width, height: h }); PNG.bitblt(src, dst, 0, y, width, h, 0, 0); return dst; };
    const f = cut(figma, from + Number(offset));
    const r = cut(shot, from);
    bad += pixelmatch(f.data, r.data, null, width, h, { threshold: Number(threshold) });
    area += width * h;
  }
  segments = { mismatched: bad, rows: area / width, pct: +((100 * bad) / area).toFixed(3) };
}
console.log(JSON.stringify({ path, figma: [figma.width, figma.height], render: [shot.width, shot.height], mismatched, pct, ...(segments ? { segments } : {}), fonts }, null, 1));
const judged = segments ? segments.pct : pct;
const sizeDiffers = !segments && (figma.width !== shot.width || figma.height !== shot.height);
if (maxPercent !== undefined && maxPercent !== "" && (judged > Number(maxPercent) || sizeDiffers)) process.exitCode = 1;
