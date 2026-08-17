/* ============================================================
   Parse an uploaded Travelers' Choice CSV (Chinese headers, the same
   format as the seed data) into Waypoint hotel objects ready for
   db.importHotels(). Port of the selection/cleaning logic in build_data.py.

   Expected headers (Chinese):
     酒店ID 酒店名称 酒店链接 评分 评论数 排名描述 排名 排名总数 地址 电话
     纬度 经度 城市 最低价格 显示价格 价格区间最低 价格区间最高 住宿类型
     酒店风格 亮点设施 促销标签 旅行者之选 旅行者之选奖项 平台SEO摘要
     用户评论摘录 用户评论用户名
   ============================================================ */

const MONTHS = ["January","February","March","April","May","June","July","August",
  "September","October","November","December"];

// A palette of gradients assigned per new city (so imported cities look distinct).
const GRADIENTS = [
  ["#1d3a5f", "#4a7ba6", "#dce7f0"], ["#4a3b5f", "#8a6fa8", "#ece4f0"],
  ["#6b3a2f", "#b07a5a", "#f0e4d8"], ["#1a2b3c", "#3f5f7a", "#dce4ea"],
  ["#7a4a2f", "#c88a5a", "#f5e6d0"], ["#3a1f2f", "#8a4f6a", "#f0dce4"],
  ["#5f2a2a", "#a85f4f", "#f0dcd0"], ["#1f3a4a", "#4f7f9a", "#dce9f0"],
  ["#2f5f4a", "#5f9a7f", "#dcf0e6"], ["#4a4a2f", "#9a9a5f", "#f0f0d0"],
];

/* ---- tiny RFC-4180-ish CSV parser (handles quotes, commas, newlines) ---- */
function parseCsv(text) {
  // strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function slugify(s, city) {
  const base = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${city}-${base}`.slice(0, 60);
}
function num(v) { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : NaN; }
function clean(v) { return (v == null ? "" : String(v)).trim(); }

function splitList(s) {
  return clean(s).split("|").map(x => x.trim()).filter(Boolean);
}
function dedupe(arr) {
  const seen = new Set(), out = [];
  for (const x of arr) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
function tagsFrom(row) { return dedupe([...splitList(row["酒店风格"]), ...splitList(row["亮点设施"])]).slice(0, 4); }
function amenitiesFrom(row) {
  const a = dedupe([...splitList(row["亮点设施"]), ...splitList(row["酒店风格"])]).slice(0, 12);
  return a.length ? a : ["Free WiFi", "24-hour reception"];
}
/* Read hotel image(s) from any of several possible column names.
   Accepts single URL or multiple separated by | , newline or space.
   Returns { image, images } — image = first/cover, images = full list. */
const IMAGE_COLS = [
  "image_url", "image", "images", "image_urls", "photo", "photos", "photo_url",
  "图片链接", "酒店图片", "图片", "图片地址", "封面图", "图片url",
];
function imagesFrom(row) {
  let raw = "";
  for (const col of IMAGE_COLS) {
    // case-insensitive match against the row's keys
    const key = Object.keys(row).find(k => k.trim().toLowerCase() === col.toLowerCase());
    if (key && clean(row[key])) { raw = clean(row[key]); break; }
  }
  if (!raw) return { image: "", images: [] };
  const urls = raw.split(/[|\n,]+/).map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s));
  return { image: urls[0] || "", images: urls };
}
function priceStr(row) {
  const lo = num(row["价格区间最低"]), hi = num(row["价格区间最高"]);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > 0) return `$${Math.round(lo)} – $${Math.round(hi)} / night`;
  const disp = clean(row["显示价格"]) || clean(row["最低价格"]);
  return disp ? `from ${disp} / night` : "Price on request";
}
function subRatings(rating, seed) {
  const base = Number(rating) || 4;
  const clamp = x => Math.round(Math.max(1, Math.min(5, x)) * 10) / 10;
  const o = i => ((seed * i) % 5 - 2) / 10;
  return {
    Location: clamp(base + 0.3 + o(7)), Cleanliness: clamp(base + 0.2 + o(3)),
    Rooms: clamp(base - 0.1 + o(11)), "Sleep quality": clamp(base + o(5)),
    Service: clamp(base + 0.1 + o(13)), Value: clamp(base - 0.3 + o(17)),
  };
}
function hashSeed(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 997; }

/*
  Options:
    cityKey   – slug for the city (defaults to slug of the 城市 column or provided)
    cityName  – display name
    country   – display country
    limit     – max hotels to keep (default 12; 0 = no cap)
    gradient  – [a,b,c] hero gradient; auto-picked if omitted
*/
export function parseTravelersChoiceCsv(text, opts = {}) {
  const rows2d = parseCsv(text);
  if (rows2d.length < 2) throw new Error("CSV appears to be empty.");
  const header = rows2d[0].map(h => h.trim());
  const required = ["酒店ID", "酒店名称", "评分"];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(`Missing required column "${col}". This importer expects a Travelers' Choice format CSV (with the original Chinese headers).`);
    }
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (arr, k) => (idx[k] != null ? arr[idx[k]] : undefined);

  // build row objects
  const records = rows2d.slice(1)
    .filter(r => r.length > 1 && clean(get(r, "酒店ID")))
    .map(r => {
      const o = {};
      for (const h of header) o[h] = get(r, h);
      return o;
    });

  // resolve city
  const rawCity = clean(records[0]?.["城市"]) || opts.cityName || "Imported";
  const cityKey = opts.cityKey || slugify(rawCity, "").replace(/^-/, "") || "imported";
  const cityName = opts.cityName || rawCity;
  const country = opts.country || "";
  const gradient = opts.gradient || GRADIENTS[hashSeed(cityKey) % GRADIENTS.length];
  const limit = opts.limit == null ? 400 : opts.limit;

  // gather quotes per hotel id
  const quotesByHotel = new Map();
  for (const rec of records) {
    const q = clean(rec["用户评论摘录"]);
    if (!q) continue;
    const hid = clean(rec["酒店ID"]);
    const arr = quotesByHotel.get(hid) || [];
    if (!arr.some(x => x.text === q)) arr.push({ text: q, user: clean(rec["用户评论用户名"]) });
    quotesByHotel.set(hid, arr);
  }

  // canonical row per hotel: prefer row with quote + seo + most reviews
  const byHotel = new Map();
  for (const rec of records) {
    const hid = clean(rec["酒店ID"]);
    const score = (clean(rec["用户评论摘录"]) ? 4 : 0) + (clean(rec["平台SEO摘要"]) ? 2 : 0) + (num(rec["评论数"]) || 0) / 1e6;
    const cur = byHotel.get(hid);
    if (!cur || score > cur._score) byHotel.set(hid, { ...rec, _score: score });
  }

  // light sanity filter (mixed quality allowed): needs a name, a real rating, and at least 1 review
  let cands = [...byHotel.values()].filter(rec => {
    const rating = num(rec["评分"]), reviews = num(rec["评论数"]);
    return clean(rec["酒店名称"]) && Number.isFinite(rating) && rating > 0 &&
           Number.isFinite(reviews) && reviews >= 1;
  });
  const nq = rec => (quotesByHotel.get(clean(rec["酒店ID"]))?.length || 0);
  cands.sort((a, b) => {
    // AI review (SEO summary) first
    const sa = clean(a["平台SEO摘要"]) ? 1 : 0, sb = clean(b["平台SEO摘要"]) ? 1 : 0;
    if (sb !== sa) return sb - sa;
    // then hotels that have real guest quotes
    const hqa = nq(a) > 0 ? 1 : 0, hqb = nq(b) > 0 ? 1 : 0;
    if (hqb !== hqa) return hqb - hqa;
    // then Travelers' Choice winners
    const tca = clean(a["旅行者之选"]) === "是" ? 1 : 0, tcb = clean(b["旅行者之选"]) === "是" ? 1 : 0;
    if (tcb !== tca) return tcb - tca;
    // then rating, then review count
    if (num(b["评分"]) !== num(a["评分"])) return num(b["评分"]) - num(a["评分"]);
    return num(b["评论数"]) - num(a["评论数"]);
  });
  if (limit > 0) cands = cands.slice(0, limit);

  const seenIds = new Set();
  const hotels = cands.map(rec => {
    const name = clean(rec["酒店名称"]);
    let hid = slugify(name || rec["酒店ID"], cityKey);
    if (seenIds.has(hid)) {
      let suffix = 2;
      while (seenIds.has(`${hid}-${suffix}`)) suffix++;
      hid = `${hid}-${suffix}`;
    }
    seenIds.add(hid);
    const rating = Math.round((num(rec["评分"]) || 0) * 10) / 10;
    const reviewCount = Number.isFinite(num(rec["评论数"])) ? Math.round(num(rec["评论数"])) : 0;
    const seed = hashSeed(hid);
    const seo = clean(rec["平台SEO摘要"]);
    const lat = num(rec["纬度"]), lng = num(rec["经度"]);
    const { image, images } = imagesFrom(rec);

    // reviews from ALL quotes
    const quotes = (quotesByHotel.get(clean(rec["酒店ID"])) || []).slice(0, 6);
    const reviews = quotes.map((q, i) => {
      const qs = (seed + i * 37) % 997;
      return {
        author: q.user || "Verified guest", from: country || cityName,
        rating: Math.min(5, Math.max(3, Math.round(rating) - (i % 2))),
        month: `${MONTHS[qs % 12]} 2026`,
        tripType: ["Couple", "Family", "Friends", "Solo", "Business"][qs % 5],
        title: ["What guests said", "A recent stay", "Traveller review", "In their own words", "From a verified guest", "Guest impressions"][qs % 6],
        text: q.text, helpful: 3 + (qs % 30), verified: true, source: "quote",
      };
    });

    return {
      id: hid, type: "Hotel", city: cityKey, cityName, country,
      name, place: clean(rec["地址"]) || cityName,
      rating, reviewCount,
      rank: clean(rec["排名描述"]) || `Traveller favourite in ${cityName}`,
      price: priceStr(rec), tags: tagsFrom(rec), gradient,
      tc: clean(rec["旅行者之选"]) === "是",
      lat: Number.isFinite(lat) ? Math.round(lat * 1e6) / 1e6 : null,
      lng: Number.isFinite(lng) ? Math.round(lng * 1e6) / 1e6 : null,
      seo,
      image, images,
      about: seo || `A Travellers' Choice favourite in ${cityName} with a ${rating.toFixed(1)} rating from ${reviewCount} guest reviews. See what recent visitors had to say below.`,
      amenities: amenitiesFrom(rec), subRatings: subRatings(rating, seed),
      _reviews: reviews,
    };
  });

  return { cityKey, cityName, country, gradient, hotels };
}
