#!/usr/bin/env node
/* ============================================================
   Download every hotel's cover image (the CSV image_url column, exported by
   build_data.py to data/image_urls.json) to public/images/hotels/<hotel-id>.<ext>.

   Run this ONCE on your own machine, then commit public/images/hotels/ with
   the code. Deploys then serve the committed files and make no requests to
   the original image host. (It is deliberately NOT hooked into the build.)

   Usage:
     npm run images                             # download missing images
     node scripts/download_images.js --force    # re-download everything
     CONCURRENCY=4 npm run images
     SKIP_IMAGE_DOWNLOAD=1 npm run build        # skip in CI if needed

   No dependencies (Node 18+ fetch). Skips files that already exist, retries
   each URL 3 times, and writes public/images/hotels/manifest.json.
   Once the files exist, server.js serves them at /images/hotels/... and
   /api/hotels returns the local path as `image` (remote URL kept in
   `imageRemote` as a fallback).
   ============================================================ */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "images", "hotels");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "2", 10));
// Identify honestly by default (set IMAGE_UA to override). Requests are
// paced (DELAY_MS between requests per worker) to stay low-volume.
const UA = process.env.IMAGE_UA || "WaypointHotelStudy/1.0 (academic research; one-time image fetch)";
const DELAY_MS = Math.max(0, parseInt(process.env.DELAY_MS || "500", 10));

if (process.env.SKIP_IMAGE_DOWNLOAD === "1") { console.log("[images] SKIP_IMAGE_DOWNLOAD=1 — skipping."); process.exit(0); }
process.on("unhandledRejection", e => { console.error("[images] unexpected error (build continues):", e?.message || e); process.exit(0); });
// hotel id -> original image_url lives in data/image_urls.json (not in the browser bundle)
const URLS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "image_urls.json"), "utf8"));
const CITY_LISTINGS = Object.entries(URLS).map(([id, image]) => ({ id, image }));
fs.mkdirSync(OUT, { recursive: true });

function extOf(url, contentType) {
  const m = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.exec(url);
  if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  if (/png/i.test(contentType || "")) return "png";
  if (/webp/i.test(contentType || "")) return "webp";
  return "jpg";
}
function existing(id) {
  for (const ext of ["jpg", "png", "webp", "gif"]) {
    const f = path.join(OUT, `${id}.${ext}`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return `${id}.${ext}`;
  }
  return null;
}

const jobs = CITY_LISTINGS.filter(h => h.image && /^https?:\/\//i.test(h.image));
const noImage = CITY_LISTINGS.length - jobs.length;
const manifest = {};
let done = 0, skipped = 0, failed = 0;
const failures = [];

async function download(h) {
  const have = existing(h.id);
  if (have && !FORCE) { manifest[h.id] = have; skipped++; return; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(h.image, {
        headers: { "User-Agent": UA, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (!/^image\//i.test(ct)) throw new Error(`not an image (${ct})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error("empty response");
      const file = `${h.id}.${extOf(h.image, ct)}`;
      fs.writeFileSync(path.join(OUT, file), buf);
      manifest[h.id] = file; done++;
      return;
    } catch (e) {
      if (attempt === 3) { failed++; failures.push(`${h.id}\t${h.image}\t${e.message}`); }
      else await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
}

console.log(`Hotels: ${CITY_LISTINGS.length}  with image_url: ${jobs.length}  without: ${noImage}`);
console.log(`Saving to ${OUT}  (concurrency ${CONCURRENCY}${FORCE ? ", --force" : ""})`);
let idx = 0;
async function worker() {
  while (idx < jobs.length) {
    const h = jobs[idx++];
    await download(h);
    if (DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS));
    const n = done + skipped + failed;
    if (n % 25 === 0 || n === jobs.length) process.stdout.write(`  ${n}/${jobs.length}  downloaded ${done}  skipped ${skipped}  failed ${failed}\n`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
if (failures.length) {
  fs.writeFileSync(path.join(OUT, "failed.tsv"), "id\turl\terror\n" + failures.join("\n") + "\n");
  console.log(`\n${failed} failed — see public/images/hotels/failed.tsv (re-run to retry just those).`);
}
console.log(`\nDone. ${done} downloaded, ${skipped} already present, ${failed} failed. manifest.json written.`);
