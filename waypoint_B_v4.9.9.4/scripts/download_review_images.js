#!/usr/bin/env node
/* ============================================================
   Download the photos attached to guest reviews (the `photos` column of
   data/reviews.csv, produced by scripts/filter_reviews.py) to
   public/images/reviews/<photo_id>.<ext>, and reviewer avatars (the `avatar`
   column) to public/images/avatars/<url-hash>.<ext>. Run ONCE on your own machine, then
   commit public/images/reviews with the code. The site shows a review photo
   only if its local file exists — the original URLs are never sent to browsers.

   Usage:
     npm run review-images                 # download missing photos
     CONCURRENCY=1 DELAY_MS=1000 npm run review-images
     IMAGE_SIZE=photo-o npm run review-images   # keep original full-size photos
     node scripts/download_review_images.js --force
   ============================================================ */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCsv } from "../import_csv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = process.argv.find(a => a.endsWith(".csv")) || path.join(ROOT, "data", "reviews.csv");
const OUT = path.join(ROOT, "public", "images", "reviews");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "2", 10));
const DELAY_MS = Math.max(0, parseInt(process.env.DELAY_MS || "500", 10));
const UA = process.env.IMAGE_UA || "WaypointHotelStudy/1.0 (academic research; one-time image fetch)";
fs.mkdirSync(OUT, { recursive: true });

function photoKey(p) {
  if (p.photo_id) return String(p.photo_id);
  let h = 2166136261; const u = String(p.url || ""); for (let i = 0; i < u.length; i++) { h ^= u.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "u" + (h >>> 0).toString(16);
}
const table = parseCsv(fs.readFileSync(SRC, "utf8"));
const header = table[0].map(h => h.trim().replace(/^\ufeff/, "").toLowerCase());
const pi = header.indexOf("photos");
if (pi < 0) { console.log("No `photos` column in " + SRC + " — nothing to download."); process.exit(0); }
const ai = header.indexOf("avatar");
const AVATAR_OUT = path.join(ROOT, "public", "images", "avatars");
fs.mkdirSync(AVATAR_OUT, { recursive: true });
const jobs = new Map();   // key -> { url, dir }
for (const r of table.slice(1)) {
  const v = (r[pi] || "").trim();
  if (v) { try { for (const p of JSON.parse(v)) if (p && /^https?:\/\//i.test(p.url)) jobs.set("p:" + photoKey(p), { url: p.url, dir: OUT, key: photoKey(p) }); } catch {} }
  if (ai >= 0) { const a = (r[ai] || "").trim(); if (/^https?:\/\//i.test(a)) { const k = photoKey({ url: a }); jobs.set("a:" + k, { url: a, dir: AVATAR_OUT, key: k }); } }
}
const list = [...jobs.values()];
console.log(`Review photos + avatars referenced: ${list.length}  →  ${OUT} / ${AVATAR_OUT}  (concurrency ${CONCURRENCY}, delay ${DELAY_MS} ms)`);

function existing(dir, key) { for (const ext of ["jpg", "png", "webp", "gif"]) { const f = path.join(dir, `${key}.${ext}`); if (fs.existsSync(f) && fs.statSync(f).size > 0) return f; } return null; }
function extOf(url, ct) { const m = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.exec(url); if (m) return m[1].toLowerCase().replace("jpeg", "jpg"); if (/png/i.test(ct)) return "png"; if (/webp/i.test(ct)) return "webp"; return "jpg"; }
let done = 0, skipped = 0, failed = 0; const failures = [];
/* TripAdvisor CDN URLs carry the size in the path: photo-o = original (large),
   photo-s = ~550 px, photo-l = ~1024 px, photo-f = ~250 px. Review photos are
   fetched at SIZE (default photo-s, plenty for a 110 px thumbnail + lightbox) and
   avatars at photo-f; if the resized variant is not available we fall back to the
   original URL. Set IMAGE_SIZE=photo-o to keep originals. */
const SIZE = process.env.IMAGE_SIZE || "photo-s";
function variants(url, dir) {
  const want = dir === AVATAR_OUT ? "photo-f" : SIZE;
  const v = url.replace(/\/media\/photo-[a-z0-9]+\//, `/media/${want}/`);
  return v !== url ? [v, url] : [url];
}
async function download({ key, url, dir }) {
  if (existing(dir, key) && !FORCE) { skipped++; return; }
  const urls = variants(url, dir);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tryUrl = urls[Math.min(attempt - 1, urls.length - 1)];   // resized first, original as fallback
    try {
      const res = await fetch(tryUrl, { headers: { "User-Agent": UA, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" }, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${tryUrl.includes("/media/photo-o/") ? "original" : "resized"})`);
      const ct = res.headers.get("content-type") || ""; if (!/^image\//i.test(ct)) throw new Error(`not an image (${ct})`);
      const buf = Buffer.from(await res.arrayBuffer()); if (buf.length < 500) throw new Error("empty response");
      fs.writeFileSync(path.join(dir, `${key}.${extOf(tryUrl, ct)}`), buf); done++; return;
    } catch (e) { if (attempt === 3) { failed++; failures.push(`${key}\t${url}\t${e.message}`); } else await new Promise(r => setTimeout(r, 800 * attempt)); }
  }
}
let idx = 0;
async function worker() {
  while (idx < list.length) {
    await download(list[idx++]);
    const n = done + skipped + failed; if (n % 25 === 0 || n === list.length) process.stdout.write(`  ${n}/${list.length}  downloaded ${done}  skipped ${skipped}  failed ${failed}\n`);
    if (DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (failures.length) fs.writeFileSync(path.join(OUT, "failed.tsv"), "key\turl\terror\n" + failures.join("\n") + "\n");
console.log(`\nDone. ${done} downloaded, ${skipped} already present, ${failed} failed${failures.length ? " (see public/images/reviews/failed.tsv)" : ""}.`);
