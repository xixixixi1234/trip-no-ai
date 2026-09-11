/* ============================================================
   Waypoint data layer.

   Uses Postgres when DATABASE_URL is set (Railway one-click Postgres).
   Falls back to an in-memory store seeded from src/cities.js when it is
   not, so the app still runs locally / in demo mode with zero setup.

   Public API (all async):
     init()                         -> prepare schema + seed if empty
     listCities()                   -> [{key,name,country,emoji,gradient}]
     listHotels({city})             -> [hotel...]
     getHotel(id)                   -> hotel | null
     getReviews(hotelId)            -> [review...]
     importHotels(rows)             -> { inserted, updated } (upsert)
     vote({hotelId, voterId, choice}) -> {hotelId, up, down, your}
     tallies()                      -> { hotelId: {up,down} }
     voteStats()                    -> aggregate participation stats
     allVotes()                     -> raw per-voter rows (admin)
   ============================================================ */

import pg from "pg";
import { CITIES, CITY_LISTINGS, CITY_REVIEWS } from "./src/cities.js";

const { Pool } = pg;
const HAS_DB = Boolean(process.env.DATABASE_URL);

let pool = null;

/* ---------------- in-memory fallback store ---------------- */
const mem = {
  cities: [...CITIES],
  hotels: [...CITY_LISTINGS],
  reviews: { ...CITY_REVIEWS },
  // votes[hotelId] = { up, down, voters: { voterId: 'up'|'down' }, sources: { voterId: 'list'|'detail' } }
  votes: {},
  voteLog: [],           // every like / dislike action: { voter_id, hotel_id, choice, result, source, at }
  // participant research tracking
  participants: {},      // pid -> { firstSeen, lastSeen, totalMs, siteFav, consentedAt, condition }
  settings: {},          // key -> value (welcome text etc.)
  hotelImages: [],       // uploaded images: { id, hotelId, mime, data(Buffer), caption, sort, isCover }
  hotelFavs: {},         // pid -> Set(hotelId)
  hotelEvents: {},       // pid -> { hotelId -> { seen, click, listMs, detailMs, reviewMs, reviewSeen, reviewTotal } }
  reviewVotes: {},       // pid -> { reviewId -> { hotelId, choice, updated } }
  saves: {},             // pid -> { hotelId -> { source, created } }
  saveEvents: [],        // { pid, hotelId, action: 'save'|'unsave', source, created }
};

/* ---------------- schema ---------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cities (
  key      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  country  TEXT,
  emoji    TEXT,
  gradient JSONB,
  image    TEXT
);
CREATE TABLE IF NOT EXISTS hotels (
  id           TEXT PRIMARY KEY,
  city         TEXT REFERENCES cities(key) ON DELETE CASCADE,
  city_name    TEXT,
  name         TEXT NOT NULL,
  place        TEXT,
  rating       REAL,
  review_count INTEGER,
  rank         TEXT,
  price        TEXT,
  tags         JSONB,
  gradient     JSONB,
  tc           BOOLEAN,
  lat          REAL,
  lng          REAL,
  seo          TEXT,
  about        TEXT,
  amenities    JSONB,
  sub_ratings  JSONB,
  image        TEXT,
  images       JSONB,
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reviews (
  id        BIGSERIAL PRIMARY KEY,
  hotel_id  TEXT REFERENCES hotels(id) ON DELETE CASCADE,
  author    TEXT,
  origin    TEXT,           -- the "from" field (reserved word, renamed)
  rating    INTEGER,
  month     TEXT,
  trip_type TEXT,
  title     TEXT,
  body      TEXT,
  helpful   INTEGER DEFAULT 0,
  verified  BOOLEAN DEFAULT false,
  source    TEXT            -- 'quote' | 'ai'
);
CREATE TABLE IF NOT EXISTS votes (
  hotel_id  TEXT,
  voter_id  TEXT,
  choice    TEXT CHECK (choice IN ('up','down')),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (hotel_id, voter_id)
);
CREATE TABLE IF NOT EXISTS vote_events (        -- full history of every like / dislike action
  id        BIGSERIAL PRIMARY KEY,
  voter_id  TEXT,
  hotel_id  TEXT,
  choice    TEXT,            -- 'up' | 'down'
  result    TEXT,            -- 'set' (vote recorded / changed) | 'cleared' (same button pressed again)
  source    TEXT,            -- 'list' | 'detail'
  at        TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS participants (
  pid         TEXT PRIMARY KEY,
  first_seen  TIMESTAMPTZ DEFAULT now(),
  last_seen   TIMESTAMPTZ DEFAULT now(),
  total_ms    BIGINT DEFAULT 0,
  site_fav    BOOLEAN DEFAULT false
);
CREATE TABLE IF NOT EXISTS hotel_images (       -- images uploaded in admin (stored in the DB so they survive redeploys)
  id        BIGSERIAL PRIMARY KEY,
  hotel_id  TEXT REFERENCES hotels(id) ON DELETE CASCADE,
  mime      TEXT,
  data      BYTEA,
  caption   TEXT,
  sort      INTEGER DEFAULT 0,
  is_cover  BOOLEAN DEFAULT false,
  created   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS hotel_favorites (
  pid       TEXT,
  hotel_id  TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (pid, hotel_id)
);
CREATE TABLE IF NOT EXISTS hotel_events (
  pid       TEXT,
  hotel_id  TEXT,
  seen      INTEGER DEFAULT 0,   -- times the card entered the viewport (list views)
  clicks    INTEGER DEFAULT 0,   -- times the detail page was opened
  list_ms   BIGINT  DEFAULT 0,   -- ms the card was visible in the list
  detail_ms BIGINT  DEFAULT 0,   -- ms spent on the detail page
  PRIMARY KEY (pid, hotel_id)
);
CREATE INDEX IF NOT EXISTS idx_hotels_city ON hotels(city);
CREATE INDEX IF NOT EXISTS idx_reviews_hotel ON reviews(hotel_id);
CREATE INDEX IF NOT EXISTS idx_votes_hotel ON votes(hotel_id);
CREATE INDEX IF NOT EXISTS idx_favs_pid ON hotel_favorites(pid);
CREATE INDEX IF NOT EXISTS idx_events_pid ON hotel_events(pid);
`;

/* ---------------- init & seed ---------------- */
export async function init() {
  if (!HAS_DB) {
    console.log("[db] No DATABASE_URL — using in-memory store (data resets on restart).");
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await pool.query(SCHEMA);
  // migrations for databases created before these columns existed
  await pool.query("ALTER TABLE hotels ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0");
  await pool.query("ALTER TABLE hotels ADD COLUMN IF NOT EXISTS image TEXT");
  await pool.query("ALTER TABLE hotels ADD COLUMN IF NOT EXISTS images JSONB");
  await pool.query("ALTER TABLE cities ADD COLUMN IF NOT EXISTS image TEXT");
  await pool.query("ALTER TABLE hotel_events ADD COLUMN IF NOT EXISTS list_ms BIGINT DEFAULT 0");
  await pool.query("ALTER TABLE hotel_events ADD COLUMN IF NOT EXISTS detail_ms BIGINT DEFAULT 0");
  // review_ms = ms the reviews section was on screen; review_seen = deepest review reached (1-based); review_total = reviews available
  await pool.query("ALTER TABLE hotel_events ADD COLUMN IF NOT EXISTS review_ms BIGINT DEFAULT 0");
  await pool.query("ALTER TABLE hotel_events ADD COLUMN IF NOT EXISTS hover_ms BIGINT DEFAULT 0");
  await pool.query("ALTER TABLE hotel_events ADD COLUMN IF NOT EXISTS review_seen INTEGER DEFAULT 0");
  await pool.query("ALTER TABLE hotel_events ADD COLUMN IF NOT EXISTS review_total INTEGER DEFAULT 0");
  await pool.query("CREATE TABLE IF NOT EXISTS issued_pids (num INTEGER PRIMARY KEY)");
  await pool.query(`CREATE TABLE IF NOT EXISTS saves (
    pid      TEXT,
    hotel_id TEXT,
    source   TEXT,
    created  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (pid, hotel_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS save_events (
    id       BIGSERIAL PRIMARY KEY,
    pid      TEXT,
    hotel_id TEXT,
    action   TEXT,
    source   TEXT,
    created  TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS review_votes (
    pid       TEXT,
    review_id TEXT,
    hotel_id  TEXT,
    choice    TEXT,             -- 'up' | 'down'
    updated   TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (pid, review_id)
  )`);
  await pool.query("ALTER TABLE participants ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE votes ADD COLUMN IF NOT EXISTS source TEXT");
  await pool.query("ALTER TABLE participants ADD COLUMN IF NOT EXISTS condition TEXT");
  await pool.query("ALTER TABLE participants ADD COLUMN IF NOT EXISTS ai_search BOOLEAN");
  await pool.query("ALTER TABLE participants ADD COLUMN IF NOT EXISTS ai_product BOOLEAN");
  await pool.query("ALTER TABLE participants ADD COLUMN IF NOT EXISTS exited_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE participants ADD COLUMN IF NOT EXISTS booked_hotel TEXT");
  await pool.query("ALTER TABLE hotels ADD COLUMN IF NOT EXISTS source_id TEXT");
  await pool.query("ALTER TABLE hotels ADD COLUMN IF NOT EXISTS details JSONB");
  for (const c of ["location TEXT", "date_visited TEXT", "photos JSONB", "language TEXT", "contributions INTEGER", "avatar TEXT"]) await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${c}`);
  // backfill source_id from the bundled seed for hotels that predate this column
  for (const h of CITY_LISTINGS) if (h.sourceId) await pool.query("UPDATE hotels SET source_id=$2 WHERE id=$1 AND source_id IS NULL", [h.id, h.sourceId]);

  // RESEED=1 replaces every hotel/review/city with the current src/cities.js
  // seed data (votes, favourites and participant tracking are kept — they are
  // keyed by hotel id, which is stable for the same hotel). Unset it afterwards.
  if (process.env.RESEED === "1") {
    console.log("[db] RESEED=1 — replacing hotels/reviews/cities with src/cities.js …");
    await pool.query("DELETE FROM reviews");
    await pool.query("DELETE FROM hotels");
    await pool.query("DELETE FROM cities");
    await pool.query("DELETE FROM settings WHERE key='reviews_file_hash'");   // so data/reviews.csv is re-imported after the reseed
  }
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM hotels");
  if (rows[0].n === 0) {
    console.log("[db] Empty database — seeding from src/cities.js …");
    await seed();
  }
  console.log("[db] Postgres ready.");
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of CITIES) {
      await client.query(
        `INSERT INTO cities(key,name,country,emoji,gradient)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
        [c.key, c.name, c.country, c.emoji, JSON.stringify(c.gradient)]
      );
    }
    for (const h of CITY_LISTINGS) {
      await upsertHotelClient(client, h);
      const revs = CITY_REVIEWS[h.id] || [];
      for (const r of revs) await insertReviewClient(client, h.id, r);
    }
    await client.query("COMMIT");
    console.log(`[db] Seeded ${CITY_LISTINGS.length} hotels.`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function upsertHotelClient(client, h) {
  await client.query(
    `INSERT INTO hotels
       (id,city,city_name,name,place,rating,review_count,rank,price,tags,gradient,tc,lat,lng,seo,about,amenities,sub_ratings,image,images,sort_order,source_id,details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (id) DO UPDATE SET
       source_id=COALESCE(EXCLUDED.source_id, hotels.source_id), details=COALESCE(EXCLUDED.details, hotels.details),
       city=EXCLUDED.city, city_name=EXCLUDED.city_name, name=EXCLUDED.name, place=EXCLUDED.place,
       rating=EXCLUDED.rating, review_count=EXCLUDED.review_count, rank=EXCLUDED.rank, price=EXCLUDED.price,
       tags=EXCLUDED.tags, gradient=EXCLUDED.gradient, tc=EXCLUDED.tc, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
       seo=EXCLUDED.seo, about=EXCLUDED.about, amenities=EXCLUDED.amenities, sub_ratings=EXCLUDED.sub_ratings,
       image=EXCLUDED.image, images=EXCLUDED.images`,
    [
      h.id, h.city, h.cityName || h.city_name, h.name, h.place, h.rating,
      h.reviewCount ?? h.review_count, h.rank, h.price,
      JSON.stringify(h.tags || []), JSON.stringify(h.gradient || []),
      Boolean(h.tc), h.lat ?? null, h.lng ?? null, h.seo || null, h.about || null,
      JSON.stringify(h.amenities || []), JSON.stringify(h.subRatings || h.sub_ratings || {}),
      h.image || null, JSON.stringify(h.images || []),
      h.sortOrder ?? h.sort_order ?? 0,
      h.sourceId || h.source_id || null,
      h.details ? JSON.stringify(h.details) : null,
    ]
  );
}

async function insertReviewClient(client, hotelId, r) {
  await client.query(
    `INSERT INTO reviews(hotel_id,author,origin,rating,month,trip_type,title,body,helpful,verified,source,location,date_visited,photos,language,contributions,avatar)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [hotelId, r.author, r.from || r.origin, r.rating, r.month, r.tripType || r.trip_type,
     r.title, r.text || r.body, r.helpful || 0, Boolean(r.verified), r.source || "quote",
     r.location || null, r.dateVisited || r.date_visited || null, JSON.stringify(r.photos || []), r.language || null,
     r.contributions ?? null, r.avatar || null]
  );
}

/* ---------------- reads ---------------- */
export async function listCities() {
  if (!HAS_DB) return mem.cities;
  const { rows } = await pool.query("SELECT key,name,country,emoji,gradient,image FROM cities ORDER BY name");
  return rows.map(r => ({ ...r, gradient: r.gradient, image: r.image || "" }));
}

/* set (or clear) a city's representative homepage image */
export async function setCityImage(cityKey, image) {
  if (!HAS_DB) {
    const c = mem.cities.find(x => x.key === cityKey);
    if (!c) throw new Error("city not found");
    c.image = image || "";
    return { key: cityKey, image: c.image };
  }
  const r = await pool.query(
    "UPDATE cities SET image=$2 WHERE key=$1 RETURNING key,image", [cityKey, image || null]
  );
  if (!r.rowCount) throw new Error("city not found");
  return { key: r.rows[0].key, image: r.rows[0].image || "" };
}

function hotelRowToApi(r) {
  return {
    id: r.id, type: "Hotel", city: r.city, cityName: r.city_name, name: r.name,
    place: r.place, rating: r.rating, reviewCount: r.review_count, rank: r.rank,
    price: r.price, tags: r.tags || [], gradient: r.gradient || [], tc: r.tc,
    lat: r.lat, lng: r.lng, seo: r.seo || "", about: r.about || "",
    amenities: r.amenities || [], subRatings: r.sub_ratings || {}, details: r.details || {},
    image: r.image || "", images: r.images || [],
    sortOrder: r.sort_order ?? 0,
  };
}

/* Default order returned by the API (used by the admin list only).
   The front end ignores this: every participant gets their own fixed
   random shuffle per city, seeded from their participant ID (see App.jsx).
   1) hotels that HAVE an AI review (seo) come first
   2) then the manual sort_order (ascending; 0 = untouched)
   3) then a deterministic pseudo-random order (stable per hotel id) */
function hasSeo(h) { return Boolean((h.seo || "").trim()); }
// stable hash → number in [0,1) from the hotel id
function idRand(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
export function defaultSort(a, b) {
  const sa = hasSeo(a) ? 0 : 1, sb = hasSeo(b) ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const oa = a.sortOrder ?? a.sort_order ?? 0, ob = b.sortOrder ?? b.sort_order ?? 0;
  if (oa !== ob) return oa - ob;
  return idRand(a.id) - idRand(b.id);   // stable "random" mix
}

export async function listHotels({ city } = {}) {
  if (!HAS_DB) {
    let list = [...mem.hotels];
    if (city) list = list.filter(h => h.city === city);
    return list.sort(defaultSort);
  }
  // SQL mirror of defaultSort: SEO group, then manual order, then stable hash of id
  const orderSql = `ORDER BY
      (CASE WHEN COALESCE(NULLIF(TRIM(seo),''),'') = '' THEN 1 ELSE 0 END),
      sort_order ASC, hashtext(id)`;
  const q = city
    ? await pool.query(`SELECT * FROM hotels WHERE city=$1 ${orderSql}`, [city])
    : await pool.query(`SELECT * FROM hotels ${orderSql}`);
  return q.rows.map(hotelRowToApi);
}

/* Persist a new manual order for a city. `orderedIds` is the full list of
   hotel ids in the desired display order; index becomes sort_order. */
export async function reorderHotels(city, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error("orderedIds must be an array");
  if (!HAS_DB) {
    const pos = new Map(orderedIds.map((id, i) => [id, i]));
    for (const h of mem.hotels) if (h.city === city && pos.has(h.id)) h.sortOrder = pos.get(h.id);
    return { updated: orderedIds.length };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query("UPDATE hotels SET sort_order=$1 WHERE id=$2 AND city=$3", [i, orderedIds[i], city]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  return { updated: orderedIds.length };
}

export async function getReviews(hotelId) {
  if (!HAS_DB) return mem.reviews[hotelId] || [];
  const { rows } = await pool.query(
    "SELECT * FROM reviews WHERE hotel_id=$1 ORDER BY source, id", [hotelId]
  );
  return rows.map(r => ({
    id: r.id, author: r.author, from: r.origin, rating: r.rating, month: r.month,
    tripType: r.trip_type, title: r.title, text: r.body, helpful: r.helpful,
    verified: r.verified, source: r.source,
    location: r.location || "", dateVisited: r.date_visited || "", photos: r.photos || [], language: r.language || "",
    contributions: r.contributions ?? null, avatar: r.avatar || "",
  }));
}

/* ---------------- guest reviews import ----------------
   rows: [{ hotelSourceId, author, rating, date, title, text, tripType }]
   Reviews are matched to hotels by TripAdvisor source id (or by our hotel id).
   For every hotel that appears in `rows`, its existing guest reviews are replaced. */
export async function importReviews(rows) {
  const bySource = new Map(), byId = new Map();
  const hotels = HAS_DB ? (await pool.query("SELECT id, source_id FROM hotels")).rows.map(r => ({ id: r.id, sourceId: r.source_id }))
                        : mem.hotels.map(h => ({ id: h.id, sourceId: h.sourceId }));
  for (const h of hotels) { if (h.sourceId) bySource.set(String(h.sourceId), h.id); byId.set(h.id, h.id); }
  const grouped = new Map(); let unmatched = 0;
  for (const r of rows) {
    const key = String(r.hotelSourceId || "").trim();
    const hid = bySource.get(key) || byId.get(key);
    if (!hid) { unmatched++; continue; }
    if (!grouped.has(hid)) grouped.set(hid, []);
    let photos = [];
    try { const a = typeof r.photos === "string" ? JSON.parse(r.photos || "[]") : (r.photos || []); if (Array.isArray(a)) photos = a.filter(x => x && x.url); } catch { photos = []; }
    grouped.get(hid).push({
      author: r.author || "Guest", from: "", rating: Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0))) || null,
      month: r.date || "", tripType: r.tripType || "", title: r.title || "", text: r.text || "",
      helpful: parseInt(r.helpful, 10) || 0, verified: false, source: "quote",
      location: r.location || "", dateVisited: r.dateVisited || "", photos, language: r.language || "",
      contributions: parseInt(r.contributions, 10) || null, avatar: r.avatar || "",
    });
  }
  let imported = 0;
  if (!HAS_DB) {
    for (const [hid, list] of grouped) { mem.reviews[hid] = list.map(x => ({ id: nextMemReviewId(), ...x })); imported += list.length; }
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [hid, list] of grouped) {
        await client.query("DELETE FROM reviews WHERE hotel_id=$1 AND source='quote'", [hid]);
        for (const r of list) await insertReviewClient(client, hid, r);
        imported += list.length;
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }
  return { hotels: grouped.size, reviews: imported, unmatchedRows: unmatched };
}

/* in-memory review ids must be unique across hotels (seed ids are per-hotel) */
let memReviewSeq = 0;
function nextMemReviewId() { return ++memReviewSeq; }
if (!HAS_DB) for (const list of Object.values(mem.reviews)) for (const r of list) r.id = nextMemReviewId();

const REVIEW_FIELDS = { author: "author", location: "location", rating: "rating", date: "month", dateVisited: "date_visited", title: "title", text: "body", tripType: "trip_type", helpful: "helpful", contributions: "contributions", language: "language" };
function cleanReviewInput(f) {
  const o = {};
  if (f.author != null) o.author = String(f.author).trim() || "Guest";
  if (f.location != null) o.location = String(f.location).trim();
  if (f.rating != null) { const n = Math.round(Number(f.rating)); o.rating = Number.isFinite(n) && n >= 1 && n <= 5 ? n : null; }
  if (f.date != null) o.date = String(f.date).trim();
  if (f.dateVisited != null) o.dateVisited = String(f.dateVisited).trim();
  if (f.title != null) o.title = String(f.title).trim();
  if (f.text != null) o.text = String(f.text).trim();
  if (f.tripType != null) o.tripType = String(f.tripType).trim();
  if (f.helpful != null) o.helpful = Math.max(0, parseInt(f.helpful, 10) || 0);
  if (f.contributions != null) o.contributions = parseInt(f.contributions, 10) || null;
  if (f.photos != null && Array.isArray(f.photos)) o.photos = f.photos.filter(x => x && x.url);
  return o;
}
/* admin: create a review for a hotel (our hotel id) */
export async function addReview(hotelId, fields) {
  const f = cleanReviewInput(fields);
  if (!f.text) throw new Error("Review text is required");
  const r = { author: f.author || "Guest", from: "", rating: f.rating ?? null, month: f.date || "", tripType: f.tripType || "", title: f.title || "", text: f.text,
              helpful: f.helpful || 0, verified: false, source: "quote", location: f.location || "", dateVisited: f.dateVisited || "", photos: f.photos || [], language: "", contributions: f.contributions ?? null, avatar: "" };
  if (!HAS_DB) {
    if (!mem.hotels.find(h => h.id === hotelId)) throw new Error("hotel not found");
    const row = { id: nextMemReviewId(), ...r }; (mem.reviews[hotelId] = mem.reviews[hotelId] || []).unshift(row); return row;
  }
  const client = await pool.connect();
  try { await insertReviewClient(client, hotelId, r); } finally { client.release(); }
  const { rows } = await pool.query("SELECT id FROM reviews WHERE hotel_id=$1 ORDER BY id DESC LIMIT 1", [hotelId]);
  return { id: rows[0]?.id, ...r };
}
/* admin: update fields of one review */
export async function updateReview(id, fields) {
  const f = cleanReviewInput(fields);
  if (!HAS_DB) {
    for (const list of Object.values(mem.reviews)) {
      const r = list.find(x => String(x.id) === String(id));
      if (r) {
        for (const [k, v] of Object.entries(f)) { if (k === "date") r.month = v; else r[k] = v; }
        return r;
      }
    }
    return null;
  }
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(f)) {
    const col = k === "photos" ? "photos" : REVIEW_FIELDS[k]; if (!col) continue;
    vals.push(k === "photos" ? JSON.stringify(v) : v); sets.push(`${col}=$${vals.length}`);
  }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await pool.query(`UPDATE reviews SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING id`, vals);
  return rows[0] || null;
}
/* admin: delete one review */
export async function deleteReview(id) {
  if (!HAS_DB) {
    for (const [hid, list] of Object.entries(mem.reviews)) {
      const i = list.findIndex(x => String(x.id) === String(id));
      if (i >= 0) { list.splice(i, 1); return { id, hotelId: hid }; }
    }
    return null;
  }
  const { rows } = await pool.query("DELETE FROM reviews WHERE id=$1 RETURNING id, hotel_id", [id]);
  return rows[0] ? { id: rows[0].id, hotelId: rows[0].hotel_id } : null;
}

/* ---------------- hotel image gallery (admin uploads) ---------------- */
let memImgSeq = 0;
export async function listHotelImages(hotelId) {       // metadata only
  if (!HAS_DB) return mem.hotelImages.filter(i => i.hotelId === hotelId).sort((a, b) => a.sort - b.sort || a.id - b.id).map(({ data, ...m }) => ({ ...m, size: data.length }));
  const { rows } = await pool.query("SELECT id, hotel_id, mime, caption, sort, is_cover, octet_length(data) AS size FROM hotel_images WHERE hotel_id=$1 ORDER BY sort, id", [hotelId]);
  return rows.map(r => ({ id: r.id, hotelId: r.hotel_id, mime: r.mime, caption: r.caption || "", sort: r.sort, isCover: r.is_cover, size: Number(r.size) }));
}
export async function allHotelImageMeta() {             // { hotelId: [{id, isCover, caption}] } for the public API
  const out = {};
  const rows = !HAS_DB ? mem.hotelImages.map(({ data, ...m }) => m) :
    (await pool.query("SELECT id, hotel_id, caption, sort, is_cover FROM hotel_images ORDER BY sort, id")).rows.map(r => ({ id: r.id, hotelId: r.hotel_id, caption: r.caption || "", sort: r.sort, isCover: r.is_cover }));
  for (const m of rows) (out[m.hotelId] = out[m.hotelId] || []).push(m);
  for (const l of Object.values(out)) l.sort((a, b) => a.sort - b.sort || a.id - b.id);
  return out;
}
export async function getHotelImage(id) {
  if (!HAS_DB) { const i = mem.hotelImages.find(x => String(x.id) === String(id)); return i ? { mime: i.mime, data: i.data } : null; }
  const { rows } = await pool.query("SELECT mime, data FROM hotel_images WHERE id=$1", [id]);
  return rows[0] || null;
}
export async function addHotelImage(hotelId, { mime, data, caption }) {
  if (!HAS_DB) {
    if (!mem.hotels.find(h => h.id === hotelId)) throw new Error("hotel not found");
    const sort = mem.hotelImages.filter(i => i.hotelId === hotelId).length;
    const img = { id: ++memImgSeq, hotelId, mime, data, caption: caption || "", sort, isCover: false }; mem.hotelImages.push(img); return { id: img.id };
  }
  const { rows } = await pool.query(
    `INSERT INTO hotel_images(hotel_id, mime, data, caption, sort) VALUES($1,$2,$3,$4,(SELECT COALESCE(MAX(sort),-1)+1 FROM hotel_images WHERE hotel_id=$1)) RETURNING id`, [hotelId, mime, data, caption || ""]);
  return { id: rows[0].id };
}
export async function updateHotelImage(id, { caption, sort }) {
  if (!HAS_DB) { const i = mem.hotelImages.find(x => String(x.id) === String(id)); if (!i) return null; if (caption != null) i.caption = caption; if (sort != null) i.sort = sort; return { id }; }
  const { rows } = await pool.query("UPDATE hotel_images SET caption=COALESCE($2,caption), sort=COALESCE($3,sort) WHERE id=$1 RETURNING id", [id, caption ?? null, sort ?? null]);
  return rows[0] || null;
}
export async function deleteHotelImage(id) {
  if (!HAS_DB) { const i = mem.hotelImages.findIndex(x => String(x.id) === String(id)); if (i < 0) return null; const [img] = mem.hotelImages.splice(i, 1); return { id, hotelId: img.hotelId }; }
  const { rows } = await pool.query("DELETE FROM hotel_images WHERE id=$1 RETURNING id, hotel_id", [id]);
  return rows[0] ? { id: rows[0].id, hotelId: rows[0].hotel_id } : null;
}
/* cover: imageId = an uploaded image id, or null = use the downloaded file (original cover) */
export async function setHotelCover(hotelId, imageId) {
  if (!HAS_DB) { for (const i of mem.hotelImages) if (i.hotelId === hotelId) i.isCover = imageId != null && String(i.id) === String(imageId); return { ok: true }; }
  await pool.query("UPDATE hotel_images SET is_cover=(id=$2) WHERE hotel_id=$1", [hotelId, imageId == null ? -1 : imageId]);
  return { ok: true };
}

/* random, never-repeating participant number between 0001 and 9999 —
   each issued number is remembered so the same one is never handed out twice.
   Nothing about the visitor (IP etc.) is read or stored. */
export async function nextPid() {
  if (!HAS_DB) {
    mem.issuedPids = mem.issuedPids || new Set();
    for (let i = 0; i < 200; i++) { const n = 1 + Math.floor(Math.random() * 9999); if (!mem.issuedPids.has(n)) { mem.issuedPids.add(n); return n; } }
    let n = 1; while (mem.issuedPids.has(n)) n++; mem.issuedPids.add(n); return n;
  }
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(Math.random() * 9999);
    const { rows } = await pool.query("INSERT INTO issued_pids(num) VALUES($1) ON CONFLICT DO NOTHING RETURNING num", [n]);
    if (rows.length) return rows[0].num;
  }
  const { rows } = await pool.query("INSERT INTO issued_pids(num) SELECT COALESCE(MAX(num),0)+1 FROM issued_pids RETURNING num");
  return rows[0].num;
}

/* the hotel the participant chose to "book" on the exit screen (one per participant) */
export async function setBooked(pid, hotelId) {
  if (!pid) return { ok: false };
  if (!HAS_DB) { const p = mem.participants[pid]; if (p) p.booked = hotelId || ""; return { ok: true }; }
  await pool.query("UPDATE participants SET booked_hotel=$2 WHERE pid=$1", [pid, hotelId || ""]);
  return { ok: true };
}
/* hotels this participant opened (for the exit review screen) */
export async function engagedHotels(pid) {
  if (!pid) return [];
  if (!HAS_DB) {
    const ev = mem.hotelEvents[pid] || {};
    return Object.entries(ev).filter(([, e]) => (e.click || 0) > 0).map(([id]) => id);
  }
  const { rows } = await pool.query("SELECT hotel_id FROM hotel_events WHERE pid=$1 AND clicks>0", [pid]);
  return rows.map(r => r.hotel_id);
}

/* participant pressed "Finish study" — records the exit moment (kept once; later presses ignored) */
export async function setExited(pid) {
  if (!pid) return { ok: false };
  if (!HAS_DB) { const p = mem.participants[pid]; if (p && !p.exitedAt) p.exitedAt = Date.now(); return { ok: true }; }
  await pool.query("UPDATE participants SET exited_at=COALESCE(exited_at, now()) WHERE pid=$1", [pid]);
  return { ok: true };
}

/* ---------------- admin resets ---------------- */
/* Wipe ALL participant data (votes, tracking, saves, review likes, participants).
   Hotels, reviews, photos and settings are untouched. */
export async function resetStudyData() {
  if (!HAS_DB) {
    mem.votes = {}; mem.voteLog = []; mem.participants = {}; mem.hotelFavs = {};
    mem.hotelEvents = {}; mem.reviewVotes = {}; mem.saves = {}; mem.saveEvents = [];
    mem.issuedPids = new Set();                                  // the number pool starts fresh too
    return { ok: true };
  }
  for (const t of ["votes", "vote_events", "participants", "hotel_favorites", "hotel_events", "review_votes", "saves", "save_events", "issued_pids"]) await pool.query(`DELETE FROM ${t}`);
  return { ok: true };
}
/* Restore all CONTENT to the shipped defaults: hotel texts/prices from src/cities.js,
   uploaded photos & covers removed, reviews re-imported from data/reviews.csv (caller does that),
   welcome / page-element / layout / display settings cleared. Participant data is untouched. */
export async function resetContent() {
  if (!HAS_DB) {
    mem.hotels = [...CITY_LISTINGS]; mem.cities = [...CITIES]; mem.reviews = { ...CITY_REVIEWS };
    mem.hotelImages = []; memImgSeq = 0;
    for (const k of Object.keys(mem.settings)) delete mem.settings[k];
    return { ok: true };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of CITIES) await client.query(
      `INSERT INTO cities(key,name,country,blurb,image) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, country=EXCLUDED.country, blurb=EXCLUDED.blurb`, [c.key, c.name, c.country, c.blurb || "", ""]);
    for (const h of CITY_LISTINGS) await upsertHotelClient(client, h);
    await client.query("DELETE FROM hotel_images");
    await client.query("DELETE FROM reviews");
    await client.query("DELETE FROM settings");
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  return { ok: true };
}

/* ---------------- saved hotels (the "Saves" list) ---------------- */
export async function setSave(pid, hotelId, on, source) {
  source = ["detail", "exit"].includes(source) ? source : "list";
  if (!HAS_DB) {
    const m = mem.saves[pid] || (mem.saves[pid] = {});
    if (on) m[hotelId] = { source, created: Date.now() }; else delete m[hotelId];
    mem.saveEvents.push({ pid, hotelId, action: on ? "save" : "unsave", source, created: new Date().toISOString() });
    return { ok: true, saved: Boolean(on) };
  }
  if (on) await pool.query(`INSERT INTO saves(pid,hotel_id,source) VALUES($1,$2,$3) ON CONFLICT (pid,hotel_id) DO NOTHING`, [pid, hotelId, source]);
  else await pool.query("DELETE FROM saves WHERE pid=$1 AND hotel_id=$2", [pid, hotelId]);
  await pool.query("INSERT INTO save_events(pid,hotel_id,action,source) VALUES($1,$2,$3,$4)", [pid, hotelId, on ? "save" : "unsave", source]);
  return { ok: true, saved: Boolean(on) };
}
export async function getSaves(pid) {
  if (!pid) return [];
  if (!HAS_DB) return Object.keys(mem.saves[pid] || {});
  const { rows } = await pool.query("SELECT hotel_id FROM saves WHERE pid=$1 ORDER BY created", [pid]);
  return rows.map(r => r.hotel_id);
}
export async function allSaveEvents() {
  if (!HAS_DB) return mem.saveEvents.slice();
  const { rows } = await pool.query("SELECT pid, hotel_id, action, source, created FROM save_events ORDER BY id");
  return rows.map(r => ({ pid: r.pid, hotelId: r.hotel_id, action: r.action, source: r.source, created: new Date(r.created).toISOString() }));
}
export async function allSavesState() {   // { pid: { hotelId: source } }
  const out = {};
  if (!HAS_DB) { for (const [pid, m] of Object.entries(mem.saves)) { out[pid] = {}; for (const [h, v] of Object.entries(m)) out[pid][h] = v.source; } return out; }
  const { rows } = await pool.query("SELECT pid, hotel_id, source FROM saves");
  for (const r of rows) (out[r.pid] = out[r.pid] || {})[r.hotel_id] = r.source || "";
  return out;
}

/* ---------------- per-review likes (participants) ---------------- */
export async function setReviewVote(pid, hotelId, reviewId, choice) {
  if (!pid || !reviewId) return { ok: false };
  if (choice !== "up" && choice !== "down") choice = null;
  if (!HAS_DB) {
    const m = mem.reviewVotes[pid] || (mem.reviewVotes[pid] = {});
    if (choice) m[String(reviewId)] = { hotelId, choice, updated: Date.now() };
    else delete m[String(reviewId)];
    return { ok: true, choice };
  }
  if (choice) await pool.query(
    `INSERT INTO review_votes(pid,review_id,hotel_id,choice,updated) VALUES($1,$2,$3,$4,now())
     ON CONFLICT (pid,review_id) DO UPDATE SET choice=$4, hotel_id=$3, updated=now()`, [pid, String(reviewId), hotelId, choice]);
  else await pool.query("DELETE FROM review_votes WHERE pid=$1 AND review_id=$2", [pid, String(reviewId)]);
  return { ok: true, choice };
}
export async function getReviewVotes(pid, hotelId) {
  if (!pid) return {};
  if (!HAS_DB) {
    const m = mem.reviewVotes[pid] || {};
    return Object.fromEntries(Object.entries(m).filter(([, v]) => !hotelId || v.hotelId === hotelId).map(([rid, v]) => [rid, v.choice]));
  }
  const { rows } = hotelId
    ? await pool.query("SELECT review_id, choice FROM review_votes WHERE pid=$1 AND hotel_id=$2", [pid, hotelId])
    : await pool.query("SELECT review_id, choice FROM review_votes WHERE pid=$1", [pid]);
  return Object.fromEntries(rows.map(r => [r.review_id, r.choice]));
}
export async function allReviewVotes() {
  if (!HAS_DB) {
    const out = [];
    for (const [pid, m] of Object.entries(mem.reviewVotes)) for (const [rid, v] of Object.entries(m)) out.push({ pid, reviewId: rid, hotelId: v.hotelId, choice: v.choice, updated: new Date(v.updated).toISOString() });
    return out;
  }
  const { rows } = await pool.query("SELECT pid, review_id, hotel_id, choice, updated FROM review_votes ORDER BY updated");
  return rows.map(r => ({ pid: r.pid, reviewId: r.review_id, hotelId: r.hotel_id, choice: r.choice, updated: r.updated ? new Date(r.updated).toISOString() : "" }));
}

/* all guest reviews, flat, for exports and statistics */
export async function allReviewsFlat() {
  if (!HAS_DB) {
    const out = [];
    for (const [hid, list] of Object.entries(mem.reviews)) for (const r of list) if (r.source === "quote") out.push({ hotelId: hid, ...r });
    return out;
  }
  const { rows } = await pool.query("SELECT * FROM reviews WHERE source='quote' ORDER BY hotel_id, id");
  return rows.map(r => ({ hotelId: r.hotel_id, id: r.id, author: r.author, location: r.location || "", rating: r.rating, month: r.month, dateVisited: r.date_visited || "",
    tripType: r.trip_type || "", title: r.title || "", text: r.body || "", helpful: r.helpful || 0, contributions: r.contributions ?? null, photos: r.photos || [], language: r.language || "" }));
}

/* how many guest reviews each hotel currently has (admin) */
export async function reviewCounts() {
  if (!HAS_DB) return Object.fromEntries(Object.entries(mem.reviews).map(([k, v]) => [k, v.filter(r => r.source === "quote").length]).filter(([, n]) => n > 0));
  const { rows } = await pool.query("SELECT hotel_id, COUNT(*)::int AS n FROM reviews WHERE source='quote' GROUP BY hotel_id");
  return Object.fromEntries(rows.map(r => [r.hotel_id, r.n]));
}

/* ---------------- import (upsert hotels + their reviews) ---------------- */
export async function importHotels(rows) {
  let inserted = 0, updated = 0;
  // give each imported hotel an incremental sort_order so the import order is preserved
  rows.forEach((h, i) => { if (h.sortOrder == null) h.sortOrder = i; });
  if (!HAS_DB) {
    for (const h of rows) {
      const idx = mem.hotels.findIndex(x => x.id === h.id);
      if (idx >= 0) { mem.hotels[idx] = h; updated++; }
      else { mem.hotels.push(h); inserted++; }
      if (!mem.cities.find(c => c.key === h.city)) {
        mem.cities.push({ key: h.city, name: h.cityName, country: h.country || "", emoji: "🏨", gradient: h.gradient });
      }
      mem.reviews[h.id] = h._reviews || [];
    }
    return { inserted, updated };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const h of rows) {
      // ensure the city exists
      await client.query(
        `INSERT INTO cities(key,name,country,emoji,gradient)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
        [h.city, h.cityName, h.country || "", "🏨", JSON.stringify(h.gradient || [])]
      );
      const before = await client.query("SELECT 1 FROM hotels WHERE id=$1", [h.id]);
      await upsertHotelClient(client, h);
      if (before.rowCount) updated++; else inserted++;
      // replace reviews for this hotel
      await client.query("DELETE FROM reviews WHERE hotel_id=$1", [h.id]);
      for (const r of (h._reviews || [])) await insertReviewClient(client, h.id, r);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { inserted, updated };
}

/* ---------------- votes ---------------- */
export async function vote({ hotelId, voterId, choice, source }) {
  source = source === "detail" ? "detail" : "list";
  if (!HAS_DB) {
    const e = mem.votes[hotelId] || { up: 0, down: 0, voters: {}, sources: {} };
    e.sources = e.sources || {};
    const prev = e.voters[voterId];
    let result;
    if (prev === choice) { e[choice] = Math.max(0, e[choice] - 1); delete e.voters[voterId]; delete e.sources[voterId]; result = "cleared"; }
    else { if (prev) e[prev] = Math.max(0, e[prev] - 1); e[choice] = (e[choice] || 0) + 1; e.voters[voterId] = choice; e.sources[voterId] = source; result = "set"; }
    mem.votes[hotelId] = e;
    mem.voteLog.push({ voter_id: voterId, hotel_id: hotelId, choice, result, source, at: new Date().toISOString() });
    return { hotelId, up: e.up, down: e.down, your: e.voters[voterId] || null };
  }
  const cur = await pool.query("SELECT choice FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
  const prev = cur.rows[0]?.choice;
  let result;
  if (prev === choice) {
    await pool.query("DELETE FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
    result = "cleared";
  } else {
    await pool.query(
      `INSERT INTO votes(hotel_id,voter_id,choice,source,updated_at) VALUES($1,$2,$3,$4,now())
       ON CONFLICT (hotel_id,voter_id) DO UPDATE SET choice=EXCLUDED.choice, source=EXCLUDED.source, updated_at=now()`,
      [hotelId, voterId, choice, source]
    );
    result = "set";
  }
  await pool.query("INSERT INTO vote_events(voter_id,hotel_id,choice,result,source) VALUES($1,$2,$3,$4,$5)", [voterId, hotelId, choice, result, source]);
  const agg = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE choice='up')::int   AS up,
       COUNT(*) FILTER (WHERE choice='down')::int AS down
     FROM votes WHERE hotel_id=$1`, [hotelId]
  );
  const mine = await pool.query("SELECT choice FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
  return { hotelId, up: agg.rows[0].up, down: agg.rows[0].down, your: mine.rows[0]?.choice || null };
}

export async function tallies() {
  if (!HAS_DB) {
    const out = {};
    for (const [id, v] of Object.entries(mem.votes)) out[id] = { up: v.up || 0, down: v.down || 0 };
    return out;
  }
  const { rows } = await pool.query(
    `SELECT hotel_id,
       COUNT(*) FILTER (WHERE choice='up')::int   AS up,
       COUNT(*) FILTER (WHERE choice='down')::int AS down
     FROM votes GROUP BY hotel_id`
  );
  const out = {};
  for (const r of rows) out[r.hotel_id] = { up: r.up, down: r.down };
  return out;
}

/* aggregate participation stats for the admin dashboard */
export async function voteStats() {
  if (!HAS_DB) {
    const voters = new Set();
    let up = 0, down = 0, hotels = 0;
    for (const v of Object.values(mem.votes)) {
      if ((v.up || 0) + (v.down || 0) > 0) hotels++;
      up += v.up || 0; down += v.down || 0;
      for (const id of Object.keys(v.voters || {})) voters.add(id);
    }
    return { totalUp: up, totalDown: down, totalVotes: up + down, uniqueVoters: voters.size, hotelsVoted: hotels };
  }
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE choice='up')::int   AS "totalUp",
       COUNT(*) FILTER (WHERE choice='down')::int AS "totalDown",
       COUNT(*)::int                              AS "totalVotes",
       COUNT(DISTINCT voter_id)::int              AS "uniqueVoters",
       COUNT(DISTINCT hotel_id)::int              AS "hotelsVoted"
     FROM votes`
  );
  return rows[0];
}

/* per-hotel tally joined with hotel names, for the admin table */
export async function voteBreakdown() {
  // every hotel is listed, including those with no votes yet
  if (!HAS_DB) {
    return mem.hotels.map(h => {
      const v = mem.votes[h.id] || {};
      return { id: h.id, name: h.name, city: h.cityName || h.city, rating: h.rating ?? null, up: v.up || 0, down: v.down || 0, net: (v.up || 0) - (v.down || 0) };
    }).sort((a, b) => (b.net - a.net) || ((b.up + b.down) - (a.up + a.down)) || a.name.localeCompare(b.name));
  }
  const { rows } = await pool.query(
    `SELECT h.id, h.name, h.city_name AS city, h.rating,
       COALESCE(COUNT(v.*) FILTER (WHERE v.choice='up'),0)::int   AS up,
       COALESCE(COUNT(v.*) FILTER (WHERE v.choice='down'),0)::int AS down
     FROM hotels h LEFT JOIN votes v ON v.hotel_id=h.id
     GROUP BY h.id, h.name, h.city_name, h.rating`
  );
  return rows.map(r => ({ ...r, net: r.up - r.down }))
    .sort((a, b) => (b.net - a.net) || ((b.up + b.down) - (a.up + a.down)) || a.name.localeCompare(b.name));
}

/* raw recent vote events (admin "all user data") */
export async function recentVotes(limit = 200) {
  if (!HAS_DB) {
    const nameOf = id => (mem.hotels.find(h => h.id === id) || {}).name || id;
    return [...mem.voteLog].reverse().slice(0, limit).map(v => ({ ...v, hotel_name: nameOf(v.hotel_id), updated_at: v.at }));
  }
  const { rows } = await pool.query(
    `SELECT v.voter_id, v.hotel_id, h.name AS hotel_name, v.choice, v.result, v.source, v.at AS updated_at
     FROM vote_events v LEFT JOIN hotels h ON h.id=v.hotel_id
     ORDER BY v.at DESC LIMIT $1`, [limit]
  );
  return rows;
}

export function usingDb() { return HAS_DB; }

/* ============================================================
   Participant research tracking
   ============================================================ */

/* ensure a participant row exists (called on first activity) */
/* ---- settings (welcome / consent text, editable in admin) ---- */
/* AI summary switches — the experimental condition. Two independent on/off
   settings, changed in admin (Study settings) or forced with env vars
   AI_SUMMARY_SEARCH=on|off and AI_SUMMARY_PRODUCT=on|off (env wins).
     search  : AI summary on the search / list page
     product : AI summary on the product / detail page */
function envSwitch(name) {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return true;
  if (["off", "0", "false", "no"].includes(v)) return false;
  return null;
}
export async function getAiSwitches() {
  const eS = envSwitch("AI_SUMMARY_SEARCH"), eP = envSwitch("AI_SUMMARY_PRODUCT");
  const search  = eS != null ? eS : (await getSetting("ai_search", "on")) !== "off";
  const product = eP != null ? eP : (await getSetting("ai_product", "on")) !== "off";
  return { search, product, lockedSearch: eS != null, lockedProduct: eP != null };
}
export function conditionLabel({ search, product }) { return `ai_search=${search ? "on" : "off"};ai_product=${product ? "on" : "off"}`; }

/* Page elements the admin can switch on/off (Study settings → Page elements).
   Keys are what the front end checks; defaults = shown unless noted. */
export const ELEMENTS = [
  ["list.price",        "Search page: price (from $X)", true],
  ["list.check",        "Search page: \"Check this hotel\" button", true],
  ["list.description",  "Search page: first sentence of the description", true],
  ["list.vote",         "Search page: Like / Dislike buttons", false],
  ["list.reviewCount",  "Search page: number of reviews", true],
  ["detail.price",      "Product page: price", true],
  ["detail.description","Product page: full description", true],
  ["detail.tags",       "Product page: style / amenity tags under the name", true],
  ["detail.vote",       "Product page: Like / Dislike buttons", false],
  ["detail.gallery",    "Product page: photo thumbnails / gallery", true],
  ["about.section",     "About block (whole section)", true],
  ["about.subRatings",  "About: sub-rating bars (Location, Rooms …)", true],
  ["about.distribution","About: Traveller rating distribution", true],
  ["about.amenities",   "About: property amenities / room features / room types", true],
  ["about.goodToKnow",  "About: Good to know (class, style, languages)", true],
  ["reviews.section",   "Guest reviews (whole section)", true],
  ["reviews.avatar",    "Reviews: reviewer avatar", true],
  ["reviews.location",  "Reviews: reviewer location", true],
  ["reviews.contributions", "Reviews: contributions count", true],
  ["reviews.helpful",   "Reviews: helpful votes", true],
  ["reviews.date",      "Reviews: review date (\"wrote a review Jul 2026\")", true],
  ["reviews.photos",    "Reviews: review photos", true],
  ["reviews.stay",      "Reviews: Date of stay", true],
  ["reviews.tripType",  "Reviews: Trip type", false],
  ["reviews.vote",      "Reviews: Helpful / Not helpful buttons", true],
  ["list.save",         "Search page: Save button", true],
  ["detail.save",       "Product page: Save button", true],
  ["saves.fab",         "Floating Saved-list button (bottom right)", true],
  ["exit.button",       "\"Finish study\" button in the header", true],
  ["tutorial",          "3-step tutorial after the participant enters their ID", true],
];
export async function getElements() {
  const defaults = Object.fromEntries(ELEMENTS.map(([k, , d]) => [k, d]));
  try { const v = await getSetting("elements", ""); if (v) return { ...defaults, ...JSON.parse(v) }; } catch {}
  return defaults;
}

export const DEFAULT_WELCOME_NO_AI = `Welcome, and thank you for taking part in this study.

How to use this site
1. Choose a city on the home page.
2. Browse the list of hotels. Each hotel shows its rating, number of reviews, price range and a short description.
3. Click a hotel to open its detail page with the full description and amenities.
4. For any hotel, you can press "Like this hotel" or "Dislike this hotel". You can change your answer at any time.
5. You may also bookmark the site using the "Bookmark this site" button.

Please browse as you normally would when planning a trip. There are no right or wrong answers.

Your participant ID, the pages you view, how long you spend on them, and your like / dislike choices are recorded for research purposes. No other personal information is collected.`;

export const DEFAULT_WELCOME = `Welcome, and thank you for taking part in this study.

How to use this site
1. Choose a city on the home page.
2. Browse the list of hotels. Each hotel shows its rating, number of reviews, price range, a short description and an AI-generated summary.
3. Click a hotel to open its detail page with the full description and amenities.
4. For any hotel, you can press "Like this hotel" or "Dislike this hotel". You can change your answer at any time.
5. You may also bookmark the site using the "Bookmark this site" button.

Please browse as you normally would when planning a trip. There are no right or wrong answers.

Your participant ID, the pages you view, how long you spend on them, and your like / dislike choices are recorded for research purposes. No other personal information is collected.`;

export async function getSetting(key, fallback = "") {
  let v;
  if (!HAS_DB) v = mem.settings[key];
  else { const { rows } = await pool.query("SELECT value FROM settings WHERE key=$1", [key]); v = rows[0]?.value; }
  return v && String(v).trim() ? v : fallback;   // empty = use the built-in default
}
export async function setSetting(key, value) {
  if (!HAS_DB) { mem.settings[key] = String(value ?? ""); return; }
  await pool.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value ?? "")]);
}

/* participant agreed to the welcome / consent text */
export async function setConsent(pid, sw) {
  if (!pid) return;
  await touchParticipant(pid);
  const label = sw ? conditionLabel(sw) : null;
  if (!HAS_DB) {
    const p = mem.participants[pid];
    p.consentedAt = p.consentedAt || Date.now();
    if (p.aiSearch == null && sw) { p.aiSearch = sw.search; p.aiProduct = sw.product; p.condition = label; }   // condition in effect when they first agreed
    return;
  }
  await pool.query(
    `UPDATE participants SET consented_at = COALESCE(consented_at, now()),
       ai_search = COALESCE(ai_search, $2), ai_product = COALESCE(ai_product, $3), condition = COALESCE(condition, $4)
     WHERE pid=$1`, [pid, sw ? sw.search : null, sw ? sw.product : null, label]);
}

export async function touchParticipant(pid) {
  if (!pid) return;
  if (!HAS_DB) {
    if (!mem.participants[pid]) mem.participants[pid] = { firstSeen: Date.now(), lastSeen: Date.now(), totalMs: 0, siteFav: false };
    else mem.participants[pid].lastSeen = Date.now();
    return;
  }
  await pool.query(
    `INSERT INTO participants(pid,first_seen,last_seen) VALUES($1,now(),now())
     ON CONFLICT (pid) DO UPDATE SET last_seen=now()`, [pid]
  );
}

/* add dwell time (ms) from a heartbeat */
export async function addDwell(pid, ms) {
  if (!pid || !Number.isFinite(ms) || ms <= 0) return;
  ms = Math.min(ms, 5 * 60 * 1000); // clamp a single heartbeat to 5 min
  if (!HAS_DB) {
    const p = mem.participants[pid] || (mem.participants[pid] = { firstSeen: Date.now(), lastSeen: Date.now(), totalMs: 0, siteFav: false });
    p.totalMs += ms; p.lastSeen = Date.now();
    return;
  }
  await pool.query(
    `INSERT INTO participants(pid,total_ms,last_seen) VALUES($1,$2,now())
     ON CONFLICT (pid) DO UPDATE SET total_ms=participants.total_ms+$2, last_seen=now()`,
    [pid, Math.round(ms)]
  );
}

/* record a hotel event.
   type: 'seen' | 'click' (n = count, default 1)
         'list_ms' | 'detail_ms' (n = milliseconds to add) */
const EVENT_COLS = { seen: "seen", click: "clicks", list_ms: "list_ms", detail_ms: "detail_ms", review_ms: "review_ms", hover_ms: "hover_ms", review_seen: "review_seen", review_total: "review_total" };
const EVENT_MAX  = { seen: 50, click: 50, list_ms: 10 * 60 * 1000, detail_ms: 10 * 60 * 1000, review_ms: 10 * 60 * 1000, hover_ms: 10 * 60 * 1000, review_seen: 500, review_total: 500 };
const EVENT_SET_MAX = new Set(["review_seen", "review_total"]);   // these store the maximum, not a sum
export async function trackHotelEvent(pid, hotelId, type, n = 1) {
  if (!pid || !hotelId || !EVENT_COLS[type]) return;
  n = Math.max(0, Math.min(EVENT_MAX[type], Math.round(Number(n) || 0)));
  if (!n) return;
  if (!HAS_DB) {
    const m = mem.hotelEvents[pid] || (mem.hotelEvents[pid] = {});
    const e = m[hotelId] || (m[hotelId] = { seen: 0, click: 0, listMs: 0, detailMs: 0, reviewMs: 0, hoverMs: 0, reviewSeen: 0, reviewTotal: 0 });
    if (type === "seen") e.seen += n; else if (type === "click") e.click += n;
    else if (type === "list_ms") e.listMs += n; else if (type === "detail_ms") e.detailMs += n;
    else if (type === "review_ms") e.reviewMs += n;
    else if (type === "hover_ms") e.hoverMs += n;
    else if (type === "review_seen") e.reviewSeen = Math.max(e.reviewSeen || 0, n);
    else if (type === "review_total") e.reviewTotal = Math.max(e.reviewTotal || 0, n);
    return;
  }
  const col = EVENT_COLS[type];
  await pool.query(
    EVENT_SET_MAX.has(type)
      ? `INSERT INTO hotel_events(pid,hotel_id,${col}) VALUES($1,$2,$3)
         ON CONFLICT (pid,hotel_id) DO UPDATE SET ${col}=GREATEST(hotel_events.${col},$3)`
      : `INSERT INTO hotel_events(pid,hotel_id,${col}) VALUES($1,$2,$3)
         ON CONFLICT (pid,hotel_id) DO UPDATE SET ${col}=hotel_events.${col}+$3`,
    [pid, hotelId, n]
  );
}

/* admin: edit a hotel's official description (about) and AI summary (seo) */
export async function updateHotelText(id, { about, seo }) {
  if (!id) return null;
  if (!HAS_DB) {
    const h = mem.hotels.find(x => x.id === id);
    if (!h) return null;
    if (about != null) h.about = String(about);
    if (seo != null) h.seo = String(seo);
    return { id, about: h.about, seo: h.seo };
  }
  const { rows } = await pool.query(
    `UPDATE hotels SET about = COALESCE($2, about), seo = COALESCE($3, seo) WHERE id=$1 RETURNING id, about, seo`,
    [id, about == null ? null : String(about), seo == null ? null : String(seo)]
  );
  return rows[0] || null;
}

/* admin export: one row per participant × hotel, joined with hotel facts and the vote */
export async function hotelEventRows() {
  const out = [];
  if (!HAS_DB) {
    const hotelOf = id => mem.hotels.find(h => h.id === id) || {};
    for (const [pid, m] of Object.entries(mem.hotelEvents)) {
      for (const [hid, e] of Object.entries(m)) {
        const h = hotelOf(hid);
        const vote = ((mem.votes[hid] || {}).voters || {})[pid] || "";
        const vote_source = ((mem.votes[hid] || {}).sources || {})[pid] || "";
        out.push({ pid, hotel_id: hid, hotel_name: h.name || hid, city: h.city || "", rating: h.rating ?? "", review_count: h.reviewCount ?? "",
                   seen: e.seen || 0, clicks: e.click || 0, vote, vote_source, list_ms: e.listMs || 0, detail_ms: e.detailMs || 0,
                   review_ms: e.reviewMs || 0, hover_ms: e.hoverMs || 0, review_seen: e.reviewSeen || 0, review_total: e.reviewTotal || 0 });
      }
    }
    // votes on hotels with no view record (e.g. voted from a state we did not observe)
    for (const [hid, v] of Object.entries(mem.votes)) {
      for (const [pid, choice] of Object.entries(v.voters || {})) {
        if (out.some(r => r.pid === pid && r.hotel_id === hid)) continue;
        const h = hotelOf(hid);
        out.push({ pid, hotel_id: hid, hotel_name: h.name || hid, city: h.city || "", rating: h.rating ?? "", review_count: h.reviewCount ?? "",
                   seen: 0, clicks: 0, vote: choice, vote_source: (v.sources || {})[pid] || "", list_ms: 0, detail_ms: 0, review_ms: 0, hover_ms: 0, review_seen: 0, review_total: 0 });
      }
    }
  } else {
    const { rows } = await pool.query(`
      SELECT k.pid, k.hotel_id, h.name AS hotel_name, h.city, h.rating, h.review_count,
             COALESCE(e.seen,0) AS seen, COALESCE(e.clicks,0) AS clicks, COALESCE(v.choice,'') AS vote, COALESCE(v.source,'') AS vote_source,
             COALESCE(e.list_ms,0) AS list_ms, COALESCE(e.detail_ms,0) AS detail_ms,
             COALESCE(e.review_ms,0) AS review_ms, COALESCE(e.hover_ms,0) AS hover_ms, COALESCE(e.review_seen,0) AS review_seen, COALESCE(e.review_total,0) AS review_total
      FROM (SELECT pid, hotel_id FROM hotel_events UNION SELECT voter_id, hotel_id FROM votes) k
      LEFT JOIN hotel_events e ON e.pid=k.pid AND e.hotel_id=k.hotel_id
      LEFT JOIN votes v ON v.voter_id=k.pid AND v.hotel_id=k.hotel_id
      LEFT JOIN hotels h ON h.id=k.hotel_id
      ORDER BY k.pid, k.hotel_id`);
    for (const r of rows) out.push({ ...r, rating: r.rating ?? "", review_count: r.review_count ?? "", list_ms: Number(r.list_ms), detail_ms: Number(r.detail_ms), review_ms: Number(r.review_ms), hover_ms: Number(r.hover_ms) });
  }
  // attach the participant's condition to every row (handy for analysis in one file)
  const cond = {};
  if (!HAS_DB) for (const [pid, p] of Object.entries(mem.participants)) cond[pid] = { s: p.aiSearch ?? null, p: p.aiProduct ?? null };
  else for (const r of (await pool.query("SELECT pid, ai_search, ai_product FROM participants")).rows) cond[r.pid] = { s: r.ai_search, p: r.ai_product };
  for (const r of out) { const c = cond[r.pid] || {}; r.ai_search = c.s ?? null; r.ai_product = c.p ?? null; }
  return out.sort((a, b) => a.pid.localeCompare(b.pid) || (b.clicks - a.clicks) || (b.seen - a.seen));
}

/* toggle whole-site favorite */
export async function setSiteFav(pid, on) {
  if (!pid) return { pid, siteFav: false };
  if (!HAS_DB) {
    const p = mem.participants[pid] || (mem.participants[pid] = { firstSeen: Date.now(), lastSeen: Date.now(), totalMs: 0, siteFav: false });
    p.siteFav = Boolean(on);
    return { pid, siteFav: p.siteFav };
  }
  await pool.query(
    `INSERT INTO participants(pid,site_fav,last_seen) VALUES($1,$2,now())
     ON CONFLICT (pid) DO UPDATE SET site_fav=$2, last_seen=now()`, [pid, Boolean(on)]
  );
  return { pid, siteFav: Boolean(on) };
}

/* toggle a hotel favorite */
export async function setHotelFav(pid, hotelId, on) {
  if (!pid || !hotelId) return { on: false };
  if (!HAS_DB) {
    const set = mem.hotelFavs[pid] || (mem.hotelFavs[pid] = new Set());
    if (on) set.add(hotelId); else set.delete(hotelId);
    return { hotelId, on: set.has(hotelId) };
  }
  if (on) {
    await pool.query(`INSERT INTO hotel_favorites(pid,hotel_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [pid, hotelId]);
  } else {
    await pool.query(`DELETE FROM hotel_favorites WHERE pid=$1 AND hotel_id=$2`, [pid, hotelId]);
  }
  return { hotelId, on: Boolean(on) };
}

/* this participant's favorites (site flag + hotel id list) */
export async function getFavorites(pid) {
  if (!pid) return { siteFav: false, hotels: [] };
  if (!HAS_DB) {
    const p = mem.participants[pid];
    return { siteFav: Boolean(p && p.siteFav), hotels: [...(mem.hotelFavs[pid] || [])] };
  }
  const pr = await pool.query("SELECT site_fav FROM participants WHERE pid=$1", [pid]);
  const fr = await pool.query("SELECT hotel_id FROM hotel_favorites WHERE pid=$1", [pid]);
  return { siteFav: Boolean(pr.rows[0]?.site_fav), hotels: fr.rows.map(r => r.hotel_id) };
}

/* admin: per-participant summary for the dashboard */
export async function participantSummaries() {
  if (!HAS_DB) {
    const pids = new Set([
      ...Object.keys(mem.participants),
      ...Object.keys(mem.hotelFavs),
      ...Object.keys(mem.hotelEvents),
    ]);
    // votes per pid (voterId === pid)
    const votesByPid = {};
    for (const v of Object.values(mem.votes)) {
      for (const [voter, choice] of Object.entries(v.voters || {})) {
        const o = votesByPid[voter] || (votesByPid[voter] = { up: 0, down: 0, upList: 0, upDetail: 0, downList: 0, downDetail: 0 });
        const src = (v.sources || {})[voter] === "detail" ? "Detail" : "List";
        if (choice === "up") { o.up++; o["up" + src]++; } else if (choice === "down") { o.down++; o["down" + src]++; }
      }
    }
    for (const k of Object.keys(votesByPid)) pids.add(k);
    return [...pids].map(pid => {
      const p = mem.participants[pid] || {};
      const favs = [...(mem.hotelFavs[pid] || [])];
      const events = mem.hotelEvents[pid] || {};
      const nameOf = id => (mem.hotels.find(h => h.id === id) || {}).name || id;
      const hotelList = Object.values(events);
      const dwelled = hotelList.filter(e => (e.listMs || 0) + (e.detailMs || 0) > 0);
      const hotelMs = dwelled.reduce((a, e) => a + (e.listMs || 0) + (e.detailMs || 0), 0);
      return {
        pid,
        totalMs: p.totalMs || 0,
        siteFav: Boolean(p.siteFav),
        consentedAt: p.consentedAt ? new Date(p.consentedAt).toISOString() : null,
        exitedAt: p.exitedAt ? new Date(p.exitedAt).toISOString() : null,
        booked: p.booked || "",
        condition: p.condition || "",
        aiSearch: p.aiSearch ?? null, aiProduct: p.aiProduct ?? null,
        likes: (votesByPid[pid] || {}).up || 0,
        dislikes: (votesByPid[pid] || {}).down || 0,
        likesList: (votesByPid[pid] || {}).upList || 0, likesDetail: (votesByPid[pid] || {}).upDetail || 0,
        dislikesList: (votesByPid[pid] || {}).downList || 0, dislikesDetail: (votesByPid[pid] || {}).downDetail || 0,
        hotelsSeen: hotelList.filter(e => (e.seen || 0) > 0 || (e.click || 0) > 0).length,
        hotelsClicked: hotelList.filter(e => (e.click || 0) > 0).length,
        avgHotelMs: dwelled.length ? Math.round(hotelMs / dwelled.length) : 0,
        upvotes: (votesByPid[pid] || {}).up || 0,
        favHotels: favs.map(id => ({ id, name: nameOf(id) })),
        hotels: Object.entries(events).map(([id, e]) => { const h = mem.hotels.find(x => x.id === id) || {}; return { id, name: h.name || id, rating: h.rating ?? null, reviewCount: h.reviewCount ?? null, seen: e.seen || 0, clicks: e.click || 0, listMs: e.listMs || 0, detailMs: e.detailMs || 0, reviewMs: e.reviewMs || 0, reviewSeen: e.reviewSeen || 0, reviewTotal: e.reviewTotal || 0, vote: ((mem.votes[id] || {}).voters || {})[pid] || "", voteSource: ((mem.votes[id] || {}).sources || {})[pid] || "" }; })
                 .sort((a, b) => (b.clicks - a.clicks) || (b.seen - a.seen)),
        firstSeen: p.firstSeen ? new Date(p.firstSeen).toISOString() : null,
        lastSeen: p.lastSeen ? new Date(p.lastSeen).toISOString() : null,
      };
    }).sort((a, b) => b.totalMs - a.totalMs);
  }
  const parts = await pool.query("SELECT pid,total_ms,site_fav,first_seen,last_seen,consented_at,exited_at,booked_hotel,condition,ai_search,ai_product FROM participants");
  const favs = await pool.query(`SELECT f.pid, f.hotel_id, h.name FROM hotel_favorites f LEFT JOIN hotels h ON h.id=f.hotel_id`);
  const events = await pool.query(`SELECT e.pid, e.hotel_id, h.name, h.rating, h.review_count, e.seen, e.clicks, e.list_ms, e.detail_ms, e.review_ms, e.review_seen, e.review_total, v.choice, v.source
                                     FROM hotel_events e LEFT JOIN hotels h ON h.id=e.hotel_id
                                     LEFT JOIN votes v ON v.voter_id=e.pid AND v.hotel_id=e.hotel_id`);
  const votes = await pool.query(`SELECT voter_id AS pid,
      COUNT(*) FILTER (WHERE choice='up')::int AS up, COUNT(*) FILTER (WHERE choice='down')::int AS down,
      COUNT(*) FILTER (WHERE choice='up' AND source='detail')::int AS up_detail, COUNT(*) FILTER (WHERE choice='down' AND source='detail')::int AS down_detail
      FROM votes GROUP BY voter_id`);

  const byPid = {};
  const ensure = pid => (byPid[pid] || (byPid[pid] = { pid, totalMs: 0, siteFav: false, consentedAt: null, condition: "", aiSearch: null, aiProduct: null, likes: 0, likesList: 0, likesDetail: 0, dislikesList: 0, dislikesDetail: 0, dislikes: 0, hotelsSeen: 0, hotelsClicked: 0, avgHotelMs: 0, upvotes: 0, favHotels: [], hotels: [], firstSeen: null, lastSeen: null }));
  for (const p of parts.rows) {
    const o = ensure(p.pid);
    o.totalMs = Number(p.total_ms) || 0; o.siteFav = Boolean(p.site_fav);
    o.firstSeen = p.first_seen; o.lastSeen = p.last_seen; o.consentedAt = p.consented_at; o.exitedAt = p.exited_at || null; o.booked = p.booked_hotel || ""; o.condition = p.condition || ""; o.aiSearch = p.ai_search; o.aiProduct = p.ai_product;
  }
  for (const f of favs.rows) ensure(f.pid).favHotels.push({ id: f.hotel_id, name: f.name || f.hotel_id });
  for (const e of events.rows) ensure(e.pid).hotels.push({ id: e.hotel_id, name: e.name || e.hotel_id, rating: e.rating ?? null, reviewCount: e.review_count ?? null, seen: e.seen || 0, clicks: e.clicks || 0, listMs: Number(e.list_ms) || 0, detailMs: Number(e.detail_ms) || 0, reviewMs: Number(e.review_ms) || 0, reviewSeen: e.review_seen || 0, reviewTotal: e.review_total || 0, vote: e.choice || "", voteSource: e.source || "" });
  for (const v of votes.rows) { const o = ensure(v.pid); o.likes = v.up; o.dislikes = v.down; o.upvotes = v.up; o.likesDetail = v.up_detail; o.likesList = v.up - v.up_detail; o.dislikesDetail = v.down_detail; o.dislikesList = v.down - v.down_detail; }
  for (const o of Object.values(byPid)) {
    o.hotels.sort((a, b) => (b.clicks - a.clicks) || (b.seen - a.seen));
    o.hotelsSeen = o.hotels.filter(h => h.seen > 0 || h.clicks > 0).length;
    o.hotelsClicked = o.hotels.filter(h => h.clicks > 0).length;
    const dw = o.hotels.filter(h => h.listMs + h.detailMs > 0);
    o.avgHotelMs = dw.length ? Math.round(dw.reduce((a, h) => a + h.listMs + h.detailMs, 0) / dw.length) : 0;
  }
  return Object.values(byPid).sort((a, b) => b.totalMs - a.totalMs);
}
