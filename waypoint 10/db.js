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
  // votes[hotelId] = { up, down, voters: { voterId: 'up'|'down' } }
  votes: {},
  // participant research tracking
  participants: {},      // pid -> { firstSeen, lastSeen, totalMs, siteFav }
  hotelFavs: {},         // pid -> Set(hotelId)
  hotelEvents: {},       // pid -> { hotelId -> { seen, click } }
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
CREATE TABLE IF NOT EXISTS participants (
  pid         TEXT PRIMARY KEY,
  first_seen  TIMESTAMPTZ DEFAULT now(),
  last_seen   TIMESTAMPTZ DEFAULT now(),
  total_ms    BIGINT DEFAULT 0,
  site_fav    BOOLEAN DEFAULT false
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
  seen      INTEGER DEFAULT 0,
  clicks    INTEGER DEFAULT 0,
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
       (id,city,city_name,name,place,rating,review_count,rank,price,tags,gradient,tc,lat,lng,seo,about,amenities,sub_ratings,image,images,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (id) DO UPDATE SET
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
    ]
  );
}

async function insertReviewClient(client, hotelId, r) {
  await client.query(
    `INSERT INTO reviews(hotel_id,author,origin,rating,month,trip_type,title,body,helpful,verified,source)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [hotelId, r.author, r.from || r.origin, r.rating, r.month, r.tripType || r.trip_type,
     r.title, r.text || r.body, r.helpful || 0, Boolean(r.verified), r.source || "quote"]
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
    amenities: r.amenities || [], subRatings: r.sub_ratings || {},
    image: r.image || "", images: r.images || [],
    sortOrder: r.sort_order ?? 0,
  };
}

/* Default display order (used front-of-house AND in admin):
   1) hotels that HAVE an AI review (seo) come first
   2) then the manual sort_order (ascending; 0 = untouched)
   3) then a deterministic pseudo-random order (stable per hotel id),
      so ratings look mixed rather than all the 5.0s bunched at the top  */
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
  }));
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
export async function vote({ hotelId, voterId, choice }) {
  if (!HAS_DB) {
    const e = mem.votes[hotelId] || { up: 0, down: 0, voters: {} };
    const prev = e.voters[voterId];
    if (prev === choice) { e[choice] = Math.max(0, e[choice] - 1); delete e.voters[voterId]; }
    else { if (prev) e[prev] = Math.max(0, e[prev] - 1); e[choice] = (e[choice] || 0) + 1; e.voters[voterId] = choice; }
    mem.votes[hotelId] = e;
    return { hotelId, up: e.up, down: e.down, your: e.voters[voterId] || null };
  }
  const cur = await pool.query("SELECT choice FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
  const prev = cur.rows[0]?.choice;
  if (prev === choice) {
    await pool.query("DELETE FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
  } else {
    await pool.query(
      `INSERT INTO votes(hotel_id,voter_id,choice,updated_at) VALUES($1,$2,$3,now())
       ON CONFLICT (hotel_id,voter_id) DO UPDATE SET choice=EXCLUDED.choice, updated_at=now()`,
      [hotelId, voterId, choice]
    );
  }
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
  if (!HAS_DB) {
    const byId = Object.fromEntries(mem.hotels.map(h => [h.id, h.name]));
    return Object.entries(mem.votes)
      .map(([id, v]) => ({ id, name: byId[id] || id, up: v.up || 0, down: v.down || 0, net: (v.up || 0) - (v.down || 0) }))
      .sort((a, b) => b.net - a.net);
  }
  const { rows } = await pool.query(
    `SELECT v.hotel_id AS id, h.name,
       COUNT(*) FILTER (WHERE choice='up')::int   AS up,
       COUNT(*) FILTER (WHERE choice='down')::int AS down
     FROM votes v LEFT JOIN hotels h ON h.id=v.hotel_id
     GROUP BY v.hotel_id, h.name`
  );
  return rows.map(r => ({ ...r, net: r.up - r.down })).sort((a, b) => b.net - a.net);
}

/* raw recent vote events (admin "all user data") */
export async function recentVotes(limit = 200) {
  if (!HAS_DB) {
    const events = [];
    for (const [hid, v] of Object.entries(mem.votes)) {
      for (const [voter, choice] of Object.entries(v.voters || {})) {
        events.push({ voter_id: voter, hotel_id: hid, choice, updated_at: null });
      }
    }
    return events.slice(0, limit);
  }
  const { rows } = await pool.query(
    `SELECT v.voter_id, v.hotel_id, h.name AS hotel_name, v.choice, v.updated_at
     FROM votes v LEFT JOIN hotels h ON h.id=v.hotel_id
     ORDER BY v.updated_at DESC NULLS LAST LIMIT $1`, [limit]
  );
  return rows;
}

export function usingDb() { return HAS_DB; }

/* ============================================================
   Participant research tracking
   ============================================================ */

/* ensure a participant row exists (called on first activity) */
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

/* record a hotel event: type 'seen' or 'click' */
export async function trackHotelEvent(pid, hotelId, type, n = 1) {
  if (!pid || !hotelId || !["seen", "click"].includes(type)) return;
  n = Math.max(1, Math.min(50, parseInt(n, 10) || 1));
  if (!HAS_DB) {
    const m = mem.hotelEvents[pid] || (mem.hotelEvents[pid] = {});
    const e = m[hotelId] || (m[hotelId] = { seen: 0, click: 0 });
    if (type === "seen") e.seen += n; else e.click += n;
    return;
  }
  const col = type === "seen" ? "seen" : "clicks";
  await pool.query(
    `INSERT INTO hotel_events(pid,hotel_id,${col}) VALUES($1,$2,$3)
     ON CONFLICT (pid,hotel_id) DO UPDATE SET ${col}=hotel_events.${col}+$3`,
    [pid, hotelId, n]
  );
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
      for (const voter of Object.keys(v.voters || {})) votesByPid[voter] = (votesByPid[voter] || 0) + 1;
    }
    for (const k of Object.keys(votesByPid)) pids.add(k);
    return [...pids].map(pid => {
      const p = mem.participants[pid] || {};
      const favs = [...(mem.hotelFavs[pid] || [])];
      const events = mem.hotelEvents[pid] || {};
      const nameOf = id => (mem.hotels.find(h => h.id === id) || {}).name || id;
      return {
        pid,
        totalMs: p.totalMs || 0,
        siteFav: Boolean(p.siteFav),
        upvotes: votesByPid[pid] || 0,
        favHotels: favs.map(id => ({ id, name: nameOf(id) })),
        hotels: Object.entries(events).map(([id, e]) => ({ id, name: nameOf(id), seen: e.seen || 0, clicks: e.click || 0 }))
                 .sort((a, b) => (b.clicks - a.clicks) || (b.seen - a.seen)),
        firstSeen: p.firstSeen ? new Date(p.firstSeen).toISOString() : null,
        lastSeen: p.lastSeen ? new Date(p.lastSeen).toISOString() : null,
      };
    }).sort((a, b) => b.totalMs - a.totalMs);
  }
  const parts = await pool.query("SELECT pid,total_ms,site_fav,first_seen,last_seen FROM participants");
  const favs = await pool.query(`SELECT f.pid, f.hotel_id, h.name FROM hotel_favorites f LEFT JOIN hotels h ON h.id=f.hotel_id`);
  const events = await pool.query(`SELECT e.pid, e.hotel_id, h.name, e.seen, e.clicks FROM hotel_events e LEFT JOIN hotels h ON h.id=e.hotel_id`);
  const votes = await pool.query(`SELECT voter_id AS pid, COUNT(*)::int AS n FROM votes GROUP BY voter_id`);

  const byPid = {};
  const ensure = pid => (byPid[pid] || (byPid[pid] = { pid, totalMs: 0, siteFav: false, upvotes: 0, favHotels: [], hotels: [], firstSeen: null, lastSeen: null }));
  for (const p of parts.rows) {
    const o = ensure(p.pid);
    o.totalMs = Number(p.total_ms) || 0; o.siteFav = Boolean(p.site_fav);
    o.firstSeen = p.first_seen; o.lastSeen = p.last_seen;
  }
  for (const f of favs.rows) ensure(f.pid).favHotels.push({ id: f.hotel_id, name: f.name || f.hotel_id });
  for (const e of events.rows) ensure(e.pid).hotels.push({ id: e.hotel_id, name: e.name || e.hotel_id, seen: e.seen || 0, clicks: e.clicks || 0 });
  for (const v of votes.rows) ensure(v.pid).upvotes = v.n;
  for (const o of Object.values(byPid)) o.hotels.sort((a, b) => (b.clicks - a.clicks) || (b.seen - a.seen));
  return Object.values(byPid).sort((a, b) => b.totalMs - a.totalMs);
}
