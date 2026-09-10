import React, { useState, useEffect, useMemo, useRef } from "react";
import { CITIES as SEED_CITIES, CITY_LISTINGS as SEED_LISTINGS } from "./cities.js";

/* Data loads live from the API (so admin CSV imports show up). The bundled
   cities.js is only a fallback for `npm run dev` without the API server. */
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* POST helper that REJECTS on network/HTTP failure so callers can show an error state. */
async function postJsonStrict(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/* fire-and-forget variant for background tracking */
function postJson(url, body) { return postJsonStrict(url, body).catch(() => null); }

/* ============================================================
   Participant research tracking (module-level singleton)
   pid comes from the opening modal; all activity is attributed to it.
   ============================================================ */
const Track = {
  pid: null,
  visible: new Set(),    // hotel ids whose list card is currently ≥50% in the viewport
  detailId: null,        // hotel whose detail page is open
  buffer: {},            // hotelId -> { list_ms, detail_ms } not yet sent
  start(pid) {
    this.pid = pid;
    if (this._hb) clearInterval(this._hb);
    if (this._tick) clearInterval(this._tick);
    if (this._flush) clearInterval(this._flush);
    // total dwell on the site (5 s heartbeat while the tab is visible)
    let last = Date.now();
    this._hb = setInterval(() => {
      if (!this.pid || document.hidden) { last = Date.now(); return; }
      const now = Date.now();
      const ms = now - last; last = now;
      if (ms > 0 && ms < 60000) postJson("/api/track/session", { pid: this.pid, ms });
    }, 5000);
    // per-hotel dwell: every second, credit 1 s to each visible list card and to the open detail page
    let lastTick = Date.now();
    this._tick = setInterval(() => {
      const now = Date.now(); const ms = now - lastTick; lastTick = now;
      if (document.hidden || ms <= 0 || ms > 5000) return;
      for (const id of this.visible) this._add(id, "list_ms", ms);
      if (this.detailId) this._add(this.detailId, "detail_ms", ms);
      if (this.reviewsVisibleId) this._add(this.reviewsVisibleId, "review_ms", ms);
    }, 1000);
    this._flush = setInterval(() => this.flush(), 5000);
    postJson("/api/track/session", { pid, ms: 0 });
    if (!this._bound) {
      this._bound = true;
      window.addEventListener("visibilitychange", () => { last = Date.now(); lastTick = Date.now(); if (document.hidden) this.flush(true); });
      window.addEventListener("pagehide", () => this.flush(true));
    }
  },
  _add(hotelId, type, ms) {
    const b = this.buffer[hotelId] || (this.buffer[hotelId] = { list_ms: 0, detail_ms: 0, review_ms: 0 });
    b[type] += ms;
  },
  reviewsVisibleId: null,   // hotel whose reviews section is currently on screen
  // send buffered dwell; `beacon` = page is closing, use sendBeacon so the request survives unload
  flush(beacon = false) {
    if (!this.pid) return;
    const items = [];
    for (const [hotelId, b] of Object.entries(this.buffer)) {
      if (b.list_ms >= 250) items.push({ hotelId, type: "list_ms", n: Math.round(b.list_ms) });
      if (b.detail_ms >= 250) items.push({ hotelId, type: "detail_ms", n: Math.round(b.detail_ms) });
      if (b.review_ms >= 250) items.push({ hotelId, type: "review_ms", n: Math.round(b.review_ms) });
    }
    if (!items.length) return;
    this.buffer = {};
    const body = JSON.stringify({ pid: this.pid, items });
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon("/api/track/batch", new Blob([body], { type: "text/plain" }));
    } else {
      fetch("/api/track/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => null);
    }
  },
  reviewDepth(hotelId, n) { if (this.pid) postJson("/api/track/event", { pid: this.pid, hotelId, type: "review_seen", n }); },
  reviewTotal(hotelId, n) { if (this.pid) postJson("/api/track/event", { pid: this.pid, hotelId, type: "review_total", n }); },
  // list card entered the viewport: +1 view, start counting list dwell
  enter(hotelId) {
    if (!this.pid || this.visible.has(hotelId)) return;
    this.visible.add(hotelId);
    postJson("/api/track/event", { pid: this.pid, hotelId, type: "seen" });
  },
  leave(hotelId) { this.visible.delete(hotelId); },
  click(hotelId) {
    if (!this.pid) return;
    postJson("/api/track/event", { pid: this.pid, hotelId, type: "click" });
  },
  openDetail(hotelId) { this.detailId = hotelId; },
  closeDetail(hotelId) { if (this.detailId === hotelId) { this.detailId = null; this.flush(); } },
};

/* ============================================================
   Design tokens — coastal: ink-teal, paper white, life-buoy orange.
   ============================================================ */
const C = {
  ink: "#122B33",
  inkSoft: "#3D5860",
  paper: "#F7F9F8",
  card: "#FFFFFF",
  sea: "#DCE9E6",
  seaDeep: "#9FBFB8",
  buoy: "#E8542F",
  buoyDim: "#F3C9BC",
  green: "#2E7D5B",
  line: "#E2EAE8",
  danger: "#B3261E",
  dangerBg: "#FCEDEB",
  successBg: "#E6F3EC",
};

/* Global stylesheet: hover / focus / active / disabled states for every
   button and card, mobile layout breakpoints, text-overflow guards and
   reduced-motion support. Inline styles cannot express :hover/:focus, so the
   state layer lives here and components opt in with the wp-* classes. */
const GLOBAL_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { overflow-x: hidden; -webkit-text-size-adjust: 100%; }
img, svg { max-width: 100%; }
button, input, textarea { font-family: 'Roboto', sans-serif; }
button { -webkit-tap-highlight-color: transparent; }
h1, h2, h3, h4 { font-style: normal; overflow-wrap: anywhere; }
.wp-text { overflow-wrap: anywhere; min-width: 0; }

.wp-btn { transition: background .12s ease, color .12s ease, border-color .12s ease, box-shadow .12s ease, transform .08s ease, opacity .12s ease; }
.wp-btn:not(:disabled) { cursor: pointer; }
.wp-btn:disabled, .wp-btn[aria-busy="true"] { opacity: .6; cursor: not-allowed; }
.wp-btn:not(:disabled):active { transform: translateY(1px); }
.wp-btn:focus-visible, .wp-card:focus-visible, .wp-input:focus-visible { outline: 2px solid ${C.buoy}; outline-offset: 2px; }

.wp-primary:not(:disabled):hover { background: #1F4450 !important; box-shadow: 0 4px 12px rgba(18,43,51,.18); }
.wp-ghost:not(:disabled):hover { background: #EEF4F2 !important; border-color: ${C.seaDeep} !important; }
.wp-accent:not(:disabled):hover { filter: brightness(0.92); box-shadow: 0 4px 12px rgba(18,43,51,.2); }
.wp-vote:not(:disabled):hover { border-color: ${C.seaDeep} !important; background: #EEF4F2 !important; }
.wp-vote.is-up:not(:disabled):hover { background: #256A4D !important; border-color: #256A4D !important; }
.wp-vote.is-down:not(:disabled):hover { background: #D0451F !important; border-color: #D0451F !important; }
.wp-link { background: none; border: none; padding: 0; }
.wp-link:not(:disabled):hover { text-decoration: underline; }

.wp-card { transition: transform .15s ease, box-shadow .15s ease; cursor: pointer; }
.wp-card:hover, .wp-card:focus-visible { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(18,43,51,.14); }

.wp-input { transition: border-color .12s ease, box-shadow .12s ease; }
.wp-input:hover { border-color: ${C.seaDeep}; }
.wp-input:focus { border-color: ${C.ink}; box-shadow: 0 0 0 3px ${C.sea}; outline: none; }
.wp-input.is-error { border-color: ${C.danger}; box-shadow: 0 0 0 3px ${C.dangerBg}; }

.wp-row { display: grid; grid-template-columns: 180px minmax(0, 1fr); }
.wp-row .wp-art { height: 100%; min-height: 128px; }
.wp-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }

@media (max-width: 600px) {
  .wp-row { grid-template-columns: minmax(0, 1fr); }
  .wp-row .wp-art { height: 160px; min-height: 0; }
  .wp-main { padding: 14px 14px 48px !important; }
  .wp-detail-pad { padding: 16px 16px 18px !important; }
  .wp-city-grid { grid-template-columns: 1fr !important; }
  .wp-about { grid-template-columns: 1fr !important; }
}
@media (max-width: 380px) {
  .wp-amenities { grid-template-columns: 1fr !important; }
}

/* hover / focus tooltip (used on the "AI summary" badge) */
.wp-tip { position: relative; cursor: help; }
.wp-tip::after {
  content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); z-index: 20;
  background: ${C.ink}; color: #fff; font-family: 'Roboto', sans-serif; font-size: 12px; line-height: 1.45;
  padding: 7px 10px; border-radius: 6px; width: max-content; max-width: min(280px, 80vw); white-space: normal;
  box-shadow: 0 6px 18px rgba(18,43,51,.18); opacity: 0; transform: translateY(-3px); pointer-events: none;
  transition: opacity .12s ease, transform .12s ease;
}
.wp-tip:hover::after, .wp-tip:focus-visible::after { opacity: 1; transform: translateY(0); }

@keyframes wp-spin { to { transform: rotate(360deg); } }
.wp-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: wp-spin .7s linear infinite; display: inline-block; vertical-align: -2px; flex: 0 0 auto; }
@keyframes wp-fade { from { opacity: 0; } to { opacity: 1; } }
.wp-fade { animation: wp-fade .25s ease; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`;

/* Saved hotels (the participant's Saves list). has/toggle via context; server-persisted. */
const SavesContext = React.createContext({ ids: [], has: () => false, toggle: () => {} });

/* /api/config, fetched once and shared (elements, AI switches, reviews display settings) */
let CONFIG_PROMISE = null;
function loadConfig() { if (!CONFIG_PROMISE) CONFIG_PROMISE = fetchJson("/api/config").catch(() => ({})); return CONFIG_PROMISE; }

/* Page-element switches from admin (Study settings → Page elements). Missing key = shown. */
const UiContext = React.createContext({});
function useShow() { const ui = React.useContext(UiContext); return (key) => ui[key] !== false; }

/* ----------------------- atoms ----------------------- */

function Buoys({ value, size = 14 }) {
  // solid dots: filled = rating, partial dot for fractions, pale dot = remainder
  const dots = [];
  for (let i = 1; i <= 5; i++) {
    const fill = Math.min(Math.max(value - (i - 1), 0), 1);
    dots.push(
      <span key={i} style={{ position: "relative", width: size, height: size, display: "inline-block" }}>
        <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: C.buoyDim }} />
        {fill > 0 && (
          <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: C.buoy,
                         clipPath: fill >= 1 ? "none" : `inset(0 ${100 - fill * 100}% 0 0)` }} />
        )}
      </span>
    );
  }
  return <span aria-label={`${value} out of 5`} style={{ display: "inline-flex", gap: size * 0.28, alignItems: "center", flex: "0 0 auto" }}>{dots}</span>;
}

function Spinner() { return <span className="wp-spinner" aria-hidden="true" />; }

/* Small inline status line used under interactive controls.
   kind: 'error' | 'success' | 'info' */
function Status({ kind, children, onRetry }) {
  if (!children) return null;
  const color = kind === "error" ? C.danger : kind === "success" ? C.green : C.inkSoft;
  return (
    <div role={kind === "error" ? "alert" : "status"} className="wp-fade" style={{ fontSize: 12.5, color, marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="wp-btn wp-link" style={{ color, fontWeight: 600, fontSize: 12.5, minHeight: 32, padding: "4px 6px", margin: "-4px 0" }}>Try again</button>
      )}
    </div>
  );
}

const AI_TIP = "This summary was created by AI, based on recent reviews.";

/* First sentence of a description (up to and including the first full stop /
   ! / ? that ends a sentence). Skips periods inside common abbreviations and
   numbers ("St. Pancras", "No. 5", "4.5"). Falls back to the whole text. */
const ABBR = /(?:\b(?:st|dr|mr|mrs|ms|no|ave|blvd|rd|sq|ste|jr|sr|vs|etc|approx|inc|ltd|co)|\b[A-Z])$/i;
const FS_MAX = 250;   // safety cap: never show more than this many characters in the list
function firstSentence(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  // sentence end: . ! ? before a space / end of text, OR a period glued to a capitalised word ("services.It is")
  const re = /[.!?]+(?=\s|$)|\.(?=[A-Z][a-z])/g;
  let out = t, m;
  while ((m = re.exec(t))) {
    const before = t.slice(0, m.index);
    if (m[0] === "." && (ABBR.test(before) || (/\d$/.test(before) && /^\d/.test(t.slice(m.index + 1))))) continue;
    out = t.slice(0, m.index + m[0].length);
    break;
  }
  if (out.length > FS_MAX) {
    const cut = out.slice(0, FS_MAX);
    out = cut.slice(0, Math.max(cut.lastIndexOf(" "), FS_MAX - 30)).replace(/[,;:\s]+$/, "") + " …";
  }
  return out;
}

function AiBadge({ color = C.buoy }) {
  return (
    <span className="wp-tip" tabIndex={0} data-tip={AI_TIP} aria-label={`AI summary. ${AI_TIP}`} style={{
      flex: "0 0 auto", fontFamily: "'Roboto Mono', monospace", fontSize: 9.5, whiteSpace: "nowrap",
      color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 5px", marginTop: 2,
    }}>AI summary</span>
  );
}

function Tag({ children }) {
  return (
    <span className="wp-text" style={{
      fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.04em",
      background: C.sea, color: C.ink, padding: "3px 8px", borderRadius: 4,
    }}>{children}</span>
  );
}

/* Per-browser voter id (module-level; stable for the page's lifetime). */
let VOTER_ID = null;
function getVoterId() {
  if (Track.pid) return Track.pid;
  if (!VOTER_ID) VOTER_ID = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  return VOTER_ID;
}

/* ----------------------- votes ----------------------- */

/* Shared vote state: this participant's own choices plus per-hotel request
   state so every Like/Dislike control can show pending / error / saved. */
function useVotes() {
  const [mine, setMine] = useState({});         // { hotelId: 'up'|'down' }
  const [pending, setPending] = useState({});   // { hotelId: true }
  const [errors, setErrors] = useState({});     // { hotelId: message }
  const [saved, setSaved] = useState({});       // { hotelId: true } — brief "Saved" flash
  const timers = useRef({});

  const vote = async (hotelId, choice, source = "list") => {
    if (pending[hotelId]) return;
    const prev = mine[hotelId];
    // optimistic update
    setMine(m => ({ ...m, [hotelId]: prev === choice ? undefined : choice }));
    setPending(p => ({ ...p, [hotelId]: true }));
    setErrors(e => ({ ...e, [hotelId]: undefined }));
    setSaved(s => ({ ...s, [hotelId]: false }));
    try {
      const d = await postJsonStrict("/api/vote", { hotelId, voterId: getVoterId(), choice, source });
      setMine(m => ({ ...m, [hotelId]: d.your || undefined }));
      setSaved(s => ({ ...s, [hotelId]: true }));
      clearTimeout(timers.current[hotelId]);
      timers.current[hotelId] = setTimeout(() => setSaved(s => ({ ...s, [hotelId]: false })), 1800);
    } catch (e) {
      // roll back and surface the failure so the participant can retry
      setMine(m => ({ ...m, [hotelId]: prev }));
      setErrors(er => ({ ...er, [hotelId]: "Couldn't save your vote. Check your connection and try again." }));
    } finally {
      setPending(p => ({ ...p, [hotelId]: false }));
    }
  };

  return { mine, pending, errors, saved, vote };
}

function LikeDislike({ hotelId, mine, pending, errors, saved, vote, size = "sm", stop = true, source = "list", only = null }) {
  const my = mine[hotelId];
  const busy = Boolean(pending[hotelId]);
  const err = errors[hotelId];
  const ok = Boolean(saved[hotelId]);
  const lastChoice = useRef(null);
  const pad = size === "lg" ? "8px 14px" : "6px 11px";
  const fs = size === "lg" ? 14 : 12.5;
  const handle = (choice) => (e) => { if (stop) e.stopPropagation(); lastChoice.current = choice; vote(hotelId, choice, source); };
  const btn = (active, activeColor) => ({
    display: "inline-flex", alignItems: "center", gap: 6, padding: pad, fontSize: fs,
    borderRadius: 99, minHeight: 34,
    border: `1px solid ${active ? activeColor : C.line}`,
    background: active ? activeColor : C.card,
    color: active ? "#fff" : C.inkSoft, fontWeight: active ? 600 : 500,
  });
  return (
    <div onClick={stop ? (e => e.stopPropagation()) : undefined} onKeyDown={stop ? (e => e.stopPropagation()) : undefined}>
      <div style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Rate this hotel">
        {only !== "down" && (<button type="button" onClick={handle("up")} disabled={busy} aria-busy={busy} aria-pressed={my === "up"}
          className={`wp-btn wp-vote${my === "up" ? " is-up" : ""}`} style={btn(my === "up", C.green)}>
          {busy && lastChoice.current === "up" ? <Spinner /> : null}
          <span>{my === "up" ? "Liked" : "Like this hotel"}</span>
        </button>)}
        {only !== "up" && (<button type="button" onClick={handle("down")} disabled={busy} aria-busy={busy} aria-pressed={my === "down"}
          className={`wp-btn wp-vote${my === "down" ? " is-down" : ""}`} style={btn(my === "down", C.buoy)}>
          {busy && lastChoice.current === "down" ? <Spinner /> : null}
          <span>{my === "down" ? "Disliked" : "Dislike this hotel"}</span>
        </button>)}
      </div>
      {err && <Status kind="error" onRetry={() => vote(hotelId, lastChoice.current || "up", source)}>{err}</Status>}
      {!err && ok && <Status kind="success">Saved</Status>}
    </div>
  );
}

/* ----------------------- bookmark (site) ----------------------- */

function BookmarkButton({ favs, size = "md" }) {
  if (!favs) return null;
  const { siteFav, sitePending, siteError, siteSaved, toggleSite } = favs;
  const big = size === "lg";
  return (
    <div>
      <button type="button" onClick={toggleSite} disabled={sitePending} aria-busy={sitePending} aria-pressed={siteFav}
        className={`wp-btn ${siteFav ? "wp-accent" : "wp-ghost"}`} style={{
          display: "inline-flex", alignItems: "center", gap: 7, minHeight: big ? 42 : 38,
          fontSize: big ? 14.5 : 14, fontWeight: 600,
          padding: big ? "9px 20px" : "8px 18px", borderRadius: 99,
          border: `1.5px solid ${siteFav ? C.buoy : C.ink}`,
          background: siteFav ? C.buoy : C.card, color: siteFav ? "#fff" : C.ink,
        }}>
        {sitePending ? <Spinner /> : <span aria-hidden="true">★</span>}
        {sitePending ? (siteFav ? "Removing…" : "Saving…") : (siteFav ? "Bookmarked" : "Bookmark this site")}
      </button>
      {siteError && <Status kind="error" onRetry={toggleSite}>{siteError}</Status>}
      {!siteError && siteSaved && <Status kind="success">{siteFav ? "Bookmark saved" : "Bookmark removed"}</Status>}
    </div>
  );
}

/* ----------------------- detail page ----------------------- */

function DetailPage({ listing, onBack, votes, showAi = true }) {
  const show = useShow();
  const layout = useLayout();
  const headerOrder = layout.detail.filter(k => ["description", "vote", "save"].includes(k));
  const sectionOrder = layout.detail.filter(k => ["about", "ai", "reviews"].includes(k));
  useEffect(() => { Track.openDetail(listing.id); return () => Track.closeDetail(listing.id); }, [listing.id]);
  const gallery = (listing.gallery && listing.gallery.length ? listing.gallery : (listing.image ? [{ src: listing.image, caption: "" }] : []));
  const [lb, setLb] = useState(null);
  return (
    <div>
      <button type="button" onClick={onBack} className="wp-btn wp-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.line}`, color: C.ink, fontWeight: 700, fontSize: 15, padding: "10px 18px", borderRadius: 99, marginBottom: 16, minHeight: 42 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        Back
      </button>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", marginBottom: 20 }}>
        <div style={{ position: "relative" }}>
          <CityArt gradient={listing.gradient} image={listing.image} imageFallback={listing.imageRemote} big flat />

        </div>
        {gallery.length > 1 && show("detail.gallery") && (
          <div style={{ display: "flex", gap: 8, padding: "10px 12px 0", overflowX: "auto" }} aria-label="Hotel photos">
            {gallery.map((g, i) => (
              <button key={g.src} type="button" onClick={() => setLb(i)} className="wp-btn" aria-label={g.caption ? `Open photo: ${g.caption}` : `Open photo ${i + 1} of ${gallery.length}`}
                style={{ padding: 0, border: `2px solid ${i === 0 ? C.ink : C.line}`, borderRadius: 8, overflow: "hidden", width: 88, height: 66, background: C.sea, flex: "0 0 auto" }}>
                <img src={g.src} alt={g.caption || ""} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              </button>
            ))}
          </div>
        )}
        {lb != null && <Lightbox photos={gallery} index={lb} onClose={() => setLb(null)} onIndex={setLb} />}
        <div className="wp-detail-pad" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 6 }}>
            {listing.type} · {listing.cityName || listing.city}
          </div>
          <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(23px, 5vw, 34px)", fontWeight: 700, margin: "0 0 6px", color: C.ink, lineHeight: 1.15 }}>
            {listing.name}
          </h1>
          <div className="wp-text" style={{ fontSize: 14.5, color: C.inkSoft, marginBottom: 12, lineHeight: 1.5 }}>{listing.place}{show("detail.price") && listing.price ? ` · ${listing.price}` : ""}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 700, color: C.ink }}>{listing.rating.toFixed(1)}</span>
            <Buoys value={listing.rating} size={16} />
            <span style={{ fontSize: 14, color: C.inkSoft }}>{(listing.reviewCount || 0).toLocaleString()} traveller reviews</span>
          </div>
          {listing.tags.length > 0 && show("detail.tags") && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
              {listing.tags.map(t => <Tag key={t}>{t}</Tag>)}
            </div>
          )}
          {headerOrder.map(k => {
            if (k === "description") {
              const desc = listing.about && listing.about.trim() && listing.about.trim() !== (listing.seo || "").trim() ? listing.about.trim() : "";
              return desc && show("detail.description") ? <p key={k} className="wp-text" style={{ fontSize: 15, lineHeight: 1.7, color: C.ink, margin: "0 0 14px", maxWidth: 720 }}>{desc}</p> : null;
            }
            if (k === "save") return show("detail.save") && Track.pid ? (
              <div key={k} style={{ paddingTop: 14, borderTop: `1px solid ${C.line}`, marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <SavePill hotelId={listing.id} source="detail" size="lg" />
                {votes && <LikeDislike hotelId={listing.id} {...votes} source="detail" size="lg" stop={false} only="down" />}
              </div>
            ) : null;
            if (k === "vote") return votes && show("detail.vote") ? (
              <div key={k} style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap", paddingTop: 16, borderTop: `1px solid ${C.line}`, marginBottom: 14 }}>
                <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600, paddingTop: 8 }}>Would you stay here?</span>
                <LikeDislike hotelId={listing.id} {...votes} size="lg" stop={false} source="detail" />
              </div>
            ) : null;
            return null;
          })}
        </div>
      </div>

      {sectionOrder.map(k => {
        if (k === "about") return show("about.section") ? <AboutSection key={k} listing={listing} /> : null;
        if (k === "ai") return listing.seo && showAi ? (
          <div key={k} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <AiBadge />
            <p className="wp-text" style={{ fontSize: 15, lineHeight: 1.7, color: C.inkSoft, margin: 0 }}>{listing.seo}</p>
          </div>
        ) : null;
        if (k === "reviews") return show("reviews.section") ? <GuestReviews key={k} hotelId={listing.id} /> : null;
        return null;
      })}
    </div>
  );
}

/* ----------------------- About (detail page) ----------------------- */

/* Horizontal rating bar, 1–5 scale */
function RatingBar({ label, value }) {
  const pct = Math.max(0, Math.min(100, ((value - 1) / 4) * 100));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px minmax(0, 1fr) 34px", alignItems: "center", gap: 10, fontSize: 13.5, color: C.ink, minHeight: 26 }}>
      <span>{label}</span>
      <span style={{ height: 8, borderRadius: 4, background: C.sea, overflow: "hidden" }} aria-hidden="true">
        <span style={{ display: "block", height: "100%", width: `${pct}%`, background: C.green, borderRadius: 4 }} />
      </span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.inkSoft, fontSize: 12.5 }}>{value.toFixed(1)}</span>
    </div>
  );
}

/* Expandable two-column list (amenities / room features / room types) */
function FeatureList({ title, items, initial = 8 }) {
  const [open, setOpen] = useState(false);
  if (!items || !items.length) return null;
  const shown = open ? items : items.slice(0, initial);
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 16, fontWeight: 600, margin: "0 0 10px", color: C.ink }}>{title}</h3>
      <ul className="wp-amenities" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "7px 16px" }}>
        {shown.map(a => <li key={a} className="wp-text" style={{ fontSize: 13.5, color: C.ink, paddingLeft: 14, position: "relative" }}><span aria-hidden="true" style={{ position: "absolute", left: 0, top: 7, width: 5, height: 5, borderRadius: "50%", background: C.green }} />{a}</li>)}
      </ul>
      {items.length > initial && (
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="wp-btn wp-link" style={{ marginTop: 8, fontSize: 13.5, color: C.ink, fontWeight: 600, minHeight: 32 }}>
          {open ? "Show less" : `Show more (${items.length - initial})`}
        </button>
      )}
    </div>
  );
}

function Stars({ value }) {
  const full = Math.floor(value), half = value - full >= 0.5;
  return (
    <span aria-label={`${value} of 5 stars`} style={{ color: C.ink, letterSpacing: 1, fontSize: 15 }}>
      {"★".repeat(full)}{half ? "½" : ""}<span style={{ color: C.seaDeep }}>{"★".repeat(5 - full - (half ? 1 : 0))}</span>
    </span>
  );
}

/* TripAdvisor-style About block, entirely from CSV data:
   overall rating + label, sub-rating bars, review distribution,
   property amenities / room features / room types, hotel class / style / languages. */
function AboutSection({ listing }) {
  const show = useShow();
  const d = listing.details || {};
  const sub = listing.subRatings || {};
  const subKeys = show("about.subRatings") ? ["Location", "Rooms", "Value", "Cleanliness", "Service", "Sleep quality"].filter(k => typeof sub[k] === "number") : [];
  const dist = show("about.distribution") ? (d.distribution || {}) : {};
  const distTotal = Object.values(dist).reduce((a, b) => a + b, 0);
  const hasLeft = subKeys.length > 0 || distTotal > 0;
  const hasRight = show("about.amenities") && ((d.propertyAmenities || []).length || (d.roomFeatures || []).length || (d.roomTypes || []).length || (listing.amenities || []).length);
  const goodToKnow = show("about.goodToKnow") ? [
    d.hotelClass ? ["Hotel class", <Stars key="s" value={d.hotelClass} />] : null,
    (d.styles || []).length ? ["Hotel style", d.styles.join(", ")] : null,
    (d.languages || []).length ? ["Languages spoken", d.languages.join(", ")] : null,
  ].filter(Boolean) : [];
  if (!hasLeft && !hasRight && !goodToKnow.length) return null;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, margin: "0 0 16px", color: C.ink }}>About</h2>
      <div className="wp-about" style={{ display: "grid", gridTemplateColumns: hasLeft && hasRight ? "minmax(0, 5fr) minmax(0, 7fr)" : "1fr", gap: "8px 36px" }}>
        {hasLeft && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 40, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{listing.rating.toFixed(1)}</span>
              <div>
                {d.label && <div style={{ fontWeight: 600, fontSize: 15, color: C.ink }}>{d.label}</div>}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Buoys value={listing.rating} size={14} />
                  <span style={{ fontSize: 13, color: C.inkSoft }}>({(listing.reviewCount || 0).toLocaleString()} reviews)</span>
                </div>
              </div>
            </div>
            {subKeys.length > 0 && (
              <div style={{ display: "grid", gap: 4, marginBottom: 18 }}>
                {subKeys.map(k => <RatingBar key={k} label={k} value={sub[k]} />)}
              </div>
            )}
            {distTotal > 0 && (
              <div style={{ marginBottom: 12 }}>
                <h3 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 15, fontWeight: 600, margin: "0 0 8px", color: C.ink }}>Traveller rating</h3>
                <div style={{ display: "grid", gap: 4 }}>
                  {["Excellent", "Good", "Average", "Poor", "Terrible"].map(k => {
                    const n = dist[k] || 0, pct = distTotal ? (n / distTotal) * 100 : 0;
                    return (
                      <div key={k} style={{ display: "grid", gridTemplateColumns: "110px minmax(0, 1fr) 56px", alignItems: "center", gap: 10, fontSize: 13.5, color: C.ink }}>
                        <span>{k}</span>
                        <span style={{ height: 8, borderRadius: 4, background: C.sea, overflow: "hidden" }} aria-hidden="true"><span style={{ display: "block", height: "100%", width: `${pct}%`, background: C.green }} /></span>
                        <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.inkSoft, fontSize: 12.5 }}>{n.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        {hasRight && (
          <div>
            <FeatureList title="Property amenities" items={(d.propertyAmenities || []).length ? d.propertyAmenities : listing.amenities} />
            <FeatureList title="Room features" items={d.roomFeatures} />
            <FeatureList title="Room types" items={d.roomTypes} initial={6} />
          </div>
        )}
      </div>
      {goodToKnow.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 8, paddingTop: 16 }}>
          <h3 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 16, fontWeight: 600, margin: "0 0 12px", color: C.ink }}>Good to know</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "12px 24px" }}>
            {goodToKnow.map(([k, v]) => (
              <div key={k}>
                <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: C.inkSoft, marginBottom: 4 }}>{k}</div>
                <div className="wp-text" style={{ fontSize: 13.5, color: C.ink }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------- exit review: pick saves + one booking before finishing ----------------------- */
function ExitReview({ pid, saves, onCancel, onFinish }) {
  const [items, setItems] = useState(null);
  const [stage, setStage] = useState(1);          // 1 = pick saves, 2 = pick the one to book
  const [booked, setBooked] = useState("");
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState({});
  useEffect(() => {
    fetchJson(`/api/my-hotels?pid=${encodeURIComponent(pid)}`).then(a => setItems(Array.isArray(a) ? a : [])).catch(() => setItems([]));
    loadConfig().then(c => setTx((c && c.exitTexts) || {}));
  }, [pid]);
  const savedItems = (items || []).filter(h => saves.has(h.id));
  const confirm = async () => {
    setBusy(true);
    try { if (booked) await postJson("/api/book", { pid, hotelId: booked }); } catch {}
    onFinish();
  };
  const Row = ({ h, right }) => (
    <div style={{ display: "flex", gap: 10, alignItems: "center", border: `1px solid ${C.line}`, background: C.card, borderRadius: 10, padding: "12px 14px", marginBottom: 8 }}>
      <span className="wp-text" style={{ minWidth: 0, flex: 1, fontWeight: 700, fontSize: 14, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name}</span>
      {right}
    </div>
  );
  return (
    <div role="dialog" aria-modal="true" aria-label="Before you finish" style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(18,43,51,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: C.card, borderRadius: 14, maxWidth: 560, width: "100%", maxHeight: "86vh", display: "flex", flexDirection: "column", boxShadow: "0 18px 60px rgba(18,43,51,.4)" }}>
        <div style={{ padding: "22px 24px 12px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: C.inkSoft, marginBottom: 4 }}>STEP {stage} OF 2</div>
          <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 20, fontWeight: 700, margin: "0 0 6px", color: C.ink }}>
            {stage === 1 ? (tx.s1Title || "Which hotels would you save?") : (tx.s2Title || "Which one would you book?")}
          </h2>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: C.inkSoft, margin: 0 }}>
            {stage === 1
              ? (tx.s1Text || "These are the hotels you looked at. Tap the heart on every hotel you would like to save.")
              : (tx.s2Text || "From the hotels you saved, pick the one you would book (optional).")}
          </p>
        </div>
        <div style={{ overflowY: "auto", padding: "4px 18px", flex: 1 }}>
          {items === null && <div style={{ padding: 18, color: C.inkSoft, fontSize: 14 }}>Loading…</div>}
          {items && stage === 1 && items.length === 0 && <div style={{ padding: 18, color: C.inkSoft, fontSize: 14 }}>You haven't opened any hotels this session.</div>}
          {items && stage === 1 && items.map(h => (
            <Row key={h.id} h={h} right={
              <button type="button" onClick={() => saves.toggle(h.id, "exit")} aria-pressed={saves.has(h.id)} aria-label={saves.has(h.id) ? `Remove ${h.name} from saves` : `Save ${h.name}`}
                className="wp-btn" style={{ display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${saves.has(h.id) ? C.buoy : C.line}`, background: saves.has(h.id) ? "#FDEEE9" : "#fff", color: C.ink, borderRadius: 99, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, minHeight: 38, flex: "0 0 auto" }}>
                <HeartIcon filled={saves.has(h.id)} size={15} /> {saves.has(h.id) ? "Saved" : "Save"}
              </button>
            } />
          ))}
          {items && stage === 2 && savedItems.map(h => (
            <Row key={h.id} h={h} right={
              <button type="button" onClick={() => setBooked(b => b === h.id ? "" : h.id)} aria-pressed={booked === h.id}
                className="wp-btn" style={{ border: `1px solid ${booked === h.id ? C.green : C.line}`, background: booked === h.id ? C.green : "#fff", color: booked === h.id ? "#fff" : C.ink, borderRadius: 99, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, minHeight: 38, flex: "0 0 auto" }}>
                {booked === h.id ? "Booking ✓" : "Book this one"}
              </button>
            } />
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap", padding: "14px 24px 20px", borderTop: `1px solid ${C.line}` }}>
          {stage === 1 && <>
            <button type="button" onClick={onCancel} className="wp-btn wp-ghost" style={{ border: `1px solid ${C.line}`, background: C.card, color: C.ink, borderRadius: 99, padding: "10px 18px", fontWeight: 600, minHeight: 42 }}>Keep browsing</button>
            <button type="button" onClick={() => savedItems.length ? setStage(2) : confirm()} disabled={busy} className="wp-btn" style={{ background: C.ink, color: "#fff", border: "none", borderRadius: 99, padding: "10px 22px", fontWeight: 700, minHeight: 42, opacity: busy ? 0.7 : 1 }}>{savedItems.length ? "Next" : (busy ? "Finishing…" : "Finish")}</button>
          </>}
          {stage === 2 && <>
            <button type="button" onClick={() => setStage(1)} className="wp-btn wp-ghost" style={{ border: `1px solid ${C.line}`, background: C.card, color: C.ink, borderRadius: 99, padding: "10px 18px", fontWeight: 600, minHeight: 42 }}>Back</button>
            <button type="button" onClick={confirm} disabled={busy} className="wp-btn" style={{ background: C.ink, color: "#fff", border: "none", borderRadius: 99, padding: "10px 20px", fontWeight: 700, minHeight: 42, opacity: busy ? 0.7 : 1 }}>
              {busy ? "Finishing…" : "Confirm & finish"}
            </button>
          </>}
        </div>
      </div>
    </div>
  );
}

/* ----------------------- Coachmark tutorial (arrows pointing at real features) -----------------------
   Shown once per device, the first time a hotel list is opened. Each step highlights a real element
   (hotel card → Save button → Check button) with a spotlight ring and an arrow tooltip.
   Wording is editable in admin → Study settings → Tutorial steps. */
function Coachmark({ steps, onDone, skippable = true }) {
  const [step, setStep] = useState(0);
  const [box, setBox] = useState(null);
  const targetFor = (i) => {
    const row = document.querySelector(".wp-row");
    if (!row) return null;
    const key = (steps[i] || {}).target || "card";
    if (key === "save") return [...row.querySelectorAll("button")].find(b => /Save this hotel|Saved/.test(b.textContent)) || row;
    if (key === "dislike") return [...row.querySelectorAll("button")].find(b => /Dislike/.test(b.textContent)) || row;
    if (key === "check") return row.querySelector(".wp-accent") || row;
    if (key === "ai") return row.querySelector(".wp-tip")?.parentElement || row;
    if (key === "saves") return document.querySelector('[aria-label^="Open saved hotels"]') || row;
    if (key === "finish") return document.getElementById("wp-finish") || row;
    return row;
  };
  useEffect(() => {
    const el = targetFor(step);
    if (!el) { onDone(); return; }
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const t = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    }, 60);
    const onR = () => { const r2 = el.getBoundingClientRect(); setBox({ top: r2.top, left: r2.left, width: r2.width, height: r2.height }); };
    window.addEventListener("resize", onR); window.addEventListener("scroll", onR, true);
    return () => { clearTimeout(t); window.removeEventListener("resize", onR); window.removeEventListener("scroll", onR, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  if (!box) return null;
  const st = steps[step] || {};
  const below = box.top + box.height + 170 < window.innerHeight || box.top < 200;   // tooltip under the target unless there is no room
  const tipTop = below ? box.top + box.height + 14 : undefined;
  const tipBottom = below ? undefined : window.innerHeight - box.top + 14;
  const tipLeft = Math.max(12, Math.min(box.left + box.width / 2 - 170, window.innerWidth - 352));
  const arrowLeft = Math.max(18, Math.min(box.left + box.width / 2 - tipLeft - 9, 322));
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="How this site works">
      <div style={{ position: "absolute", inset: 0, background: "rgba(18,43,51,0.55)" }} onClick={() => {}} />
      <div style={{ position: "absolute", top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12,
                    borderRadius: 14, boxShadow: "0 0 0 4000px rgba(18,43,51,0.55)", outline: `3px solid ${C.buoy}`, pointerEvents: "none", background: "transparent" }} />
      <div style={{ position: "fixed", top: tipTop, bottom: tipBottom, left: tipLeft, width: 340, background: C.card, borderRadius: 12,
                    padding: "16px 18px 12px", boxShadow: "0 14px 44px rgba(18,43,51,.45)" }}>
        <span style={{ position: "absolute", [below ? "top" : "bottom"]: -9, left: arrowLeft, width: 0, height: 0,
                       borderLeft: "9px solid transparent", borderRight: "9px solid transparent",
                       [below ? "borderBottom" : "borderTop"]: `9px solid ${C.card}` }} aria-hidden="true" />
        <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 16, fontWeight: 700, color: C.ink, marginBottom: 5 }}>{st.title}</div>
        <p className="wp-text" style={{ fontSize: 13.5, lineHeight: 1.6, color: C.inkSoft, margin: "0 0 12px" }}>{st.text}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: C.inkSoft, flex: 1 }}>{step + 1} / {steps.length}</span>
          {step > 0 && <button type="button" onClick={() => setStep(sn => sn - 1)} className="wp-btn wp-ghost" style={{ border: `1px solid ${C.line}`, background: C.card, color: C.ink, borderRadius: 99, padding: "7px 14px", fontWeight: 600, fontSize: 13, minHeight: 36 }}>Back</button>}
          {step < steps.length - 1
            ? <button type="button" onClick={() => setStep(sn => sn + 1)} className="wp-btn" style={{ background: C.ink, color: "#fff", border: "none", borderRadius: 99, padding: "7px 16px", fontWeight: 700, fontSize: 13, minHeight: 36 }}>Next</button>
            : <button type="button" onClick={onDone} className="wp-btn" style={{ background: C.green, color: "#fff", border: "none", borderRadius: 99, padding: "7px 16px", fontWeight: 700, fontSize: 13, minHeight: 36 }}>Got it</button>}
          {skippable && <button type="button" onClick={onDone} className="wp-btn wp-link" style={{ fontSize: 12, color: C.inkSoft, minHeight: 30 }}>Skip</button>}
        </div>
      </div>
    </div>
  );
}

/* ----------------------- Saves (heart button + floating list) ----------------------- */

function HeartIcon({ filled, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? C.buoy : "none"} stroke={filled ? C.buoy : C.ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
    </svg>
  );
}

/* Labeled Save button shown where Like/Dislike used to be */
function SavePill({ hotelId, source, size = "md" }) {
  const saves = React.useContext(SavesContext);
  const on = saves.has(hotelId);
  const pad = size === "lg" ? "14px 28px" : "8px 16px";
  return (
    <button type="button"
      onClick={e => { e.stopPropagation(); saves.toggle(hotelId, source); }}
      onKeyDown={e => e.stopPropagation()}
      aria-pressed={on}
      className="wp-btn wp-ghost"
      style={{ display: "inline-flex", alignItems: "center", gap: 8, border: `1px solid ${on ? C.buoy : C.line}`,
               background: on ? "#FDEEE9" : C.card, color: C.ink, borderRadius: 99, padding: pad,
               fontSize: size === "lg" ? 16.5 : 13.5, fontWeight: 700, minHeight: size === "lg" ? 52 : 40 }}>
      <HeartIcon filled={on} size={size === "lg" ? 20 : 15} />
      {on ? "Saved" : "Save this hotel"}
    </button>
  );
}

/* Round heart button (top-right of cards / detail hero), TripAdvisor-style */
function SaveButton({ hotelId, source, size = 38 }) {
  const saves = React.useContext(SavesContext);
  const on = saves.has(hotelId);
  return (
    <button type="button"
      onClick={e => { e.stopPropagation(); saves.toggle(hotelId, source); }}
      onKeyDown={e => e.stopPropagation()}
      aria-label={on ? "Remove from saves" : "Save this hotel"} aria-pressed={on} title={on ? "Saved" : "Save"}
      className="wp-btn"
      style={{ width: size, height: size, borderRadius: "50%", background: "#fff", border: `1px solid ${C.line}`,
               display: "inline-flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(18,43,51,.18)", flex: "0 0 auto", padding: 0 }}>
      <HeartIcon filled={on} size={Math.round(size * 0.52)} />
    </button>
  );
}

/* Floating "Saves" button (bottom right) + slide-in list, like a cart */
function SavesFab({ allHotels, onOpen }) {
  const show = useShow();
  const saves = React.useContext(SavesContext);
  const [open, setOpen] = useState(false);
  if (!show("saves.fab") || !Track.pid) return null;
  const items = saves.ids.map(id => allHotels.find(h => h.id === id)).filter(Boolean);
  return (
    <>
      <button type="button" onClick={() => setOpen(o => !o)} aria-label={`Open saved hotels (${items.length})`}
        className="wp-btn"
        style={{ position: "fixed", right: 18, bottom: 18, zIndex: 900, display: "inline-flex", alignItems: "center", gap: 8,
                 background: C.ink, color: "#fff", border: "none", borderRadius: 99, padding: "12px 18px", fontWeight: 700, fontSize: 14.5,
                 boxShadow: "0 6px 20px rgba(18,43,51,.35)", minHeight: 46 }}>
        <HeartIcon filled={items.length > 0} size={18} /> Saves
        <span style={{ background: C.buoy, borderRadius: 99, minWidth: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, padding: "0 6px" }}>{items.length}</span>
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Saved hotels" onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 950, background: "rgba(18,43,51,0.45)", display: "flex", justifyContent: "flex-end" }}>
          <div onClick={e => e.stopPropagation()} className="wp-drawer"
            style={{ width: "min(400px, 100%)", height: "100%", background: C.paper, boxShadow: "-8px 0 30px rgba(18,43,51,.25)", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: `1px solid ${C.line}`, background: C.card }}>
              <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 18, fontWeight: 700, margin: 0, color: C.ink }}>Saved hotels ({items.length})</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="wp-btn wp-ghost" style={{ border: `1px solid ${C.line}`, background: C.card, color: C.ink, borderRadius: 99, width: 34, height: 34, fontSize: 16, fontWeight: 700 }}>✕</button>
            </div>
            <div style={{ overflowY: "auto", padding: 14, flex: 1 }}>
              {items.length === 0 && (
                <div style={{ color: C.inkSoft, fontSize: 14, padding: 20, textAlign: "center" }}>
                  Nothing saved yet. Tap the <HeartIcon filled={false} size={14} /> on any hotel to add it here.
                </div>
              )}
              {items.map(l => (
                <div key={l.id} style={{ display: "flex", gap: 10, alignItems: "center", background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, marginBottom: 10 }}>
                  <button type="button" onClick={() => { setOpen(false); onOpen(l); }} aria-label={`Open ${l.name}`} className="wp-btn"
                    style={{ display: "flex", gap: 10, alignItems: "center", flex: 1, minWidth: 0, textAlign: "left", padding: 0, background: "none", border: "none" }}>
                    <span style={{ width: 62, height: 50, borderRadius: 8, overflow: "hidden", flex: "0 0 auto", background: C.sea }}>
                      {l.image ? <img src={l.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : null}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="wp-text" style={{ display: "block", fontWeight: 700, fontSize: 14, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
                      <span style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: C.inkSoft }}>
                        <Buoys value={l.rating} size={10} /> {l.rating.toFixed(1)} · {l.cityName}{l.price ? ` · ${l.price}` : ""}
                      </span>
                    </span>
                  </button>
                  <button type="button" onClick={() => saves.toggle(l.id, "list")} aria-label={`Remove ${l.name} from saves`} className="wp-btn wp-ghost"
                    style={{ border: "none", background: "none", color: C.inkSoft, fontSize: 15, padding: 6, minHeight: 32 }}>✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ----------------------- guest reviews (detail page) ----------------------- */

/* Imported guest reviews for one hotel. States: loading / error (retry) / empty / list.
   Shows 5 at a time with a "Show more" button. Only real imported reviews are shown —
   nothing is generated when a hotel has none. */
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/* "2025-09-08" → "Sep 2025" (or "September 2025" with long=true); anything unparseable is shown as-is */
function fmtMonth(v, long = false) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(v || "").trim());
  if (!m) return String(v || "").trim();
  return `${(long ? MONTHS_LONG : MONTHS_SHORT)[parseInt(m[2], 10) - 1] || ""} ${m[1]}`.trim();
}

/* Reviewer avatar: local file if downloaded, otherwise the first letter of the name on a coloured disc */
function Avatar({ src, name }) {
  const [broken, setBroken] = useState(false);
  const letter = (String(name || "G").trim()[0] || "G").toUpperCase();
  const hue = hashStr(name || "") % 360;
  return (
    <span aria-hidden="true" style={{ width: 48, height: 48, borderRadius: "50%", flex: "0 0 auto", overflow: "hidden", background: `hsl(${hue} 35% 88%)`, display: "inline-flex", alignItems: "center", justifyContent: "center", color: `hsl(${hue} 40% 30%)`, fontWeight: 700, fontSize: 18 }}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : letter}
    </span>
  );
}

/* Minimal photo viewer: click outside / Esc closes, arrows navigate. Photos are local files. */
function Lightbox({ photos, index, onClose, onIndex }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowRight") onIndex((index + 1) % photos.length); if (e.key === "ArrowLeft") onIndex((index - 1 + photos.length) % photos.length); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length, onClose, onIndex]);
  const p = photos[index];
  return (
    <div role="dialog" aria-modal="true" aria-label="Photo" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(18,43,51,0.88)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: "min(960px, 100%)", maxHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <img src={p.src} alt={p.caption || ""} style={{ maxWidth: "100%", maxHeight: "78vh", borderRadius: 10, objectFit: "contain", background: "#000" }} />
        <div style={{ color: "#fff", fontSize: 13.5, textAlign: "center", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
          {photos.length > 1 && <button type="button" onClick={() => onIndex((index - 1 + photos.length) % photos.length)} className="wp-btn wp-link" aria-label="Previous photo" style={{ color: "#fff", fontSize: 18, minHeight: 36, padding: "0 8px" }}>‹</button>}
          <span className="wp-text">{p.caption || ""}{photos.length > 1 ? `${p.caption ? " · " : ""}${index + 1} / ${photos.length}` : ""}</span>
          {photos.length > 1 && <button type="button" onClick={() => onIndex((index + 1) % photos.length)} className="wp-btn wp-link" aria-label="Next photo" style={{ color: "#fff", fontSize: 18, minHeight: 36, padding: "0 8px" }}>›</button>}
          <button type="button" onClick={onClose} className="wp-btn wp-ghost" style={{ background: "#fff", color: C.ink, border: "none", borderRadius: 99, padding: "6px 14px", fontWeight: 600, minHeight: 34 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* Scrolling mode: when this marker becomes visible the next batch is appended automatically. */
function MoreSentinel({ onMore, left }) {
  const ref = React.useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) onMore(); }, { rootMargin: "200px" });
    obs.observe(el); return () => obs.disconnect();
  }, [onMore]);
  return (
    <div ref={ref} style={{ display: "flex", justifyContent: "center", padding: "10px 0 2px" }}>
      <button type="button" onClick={onMore} className="wp-btn wp-ghost" style={{ border: "1px solid " + C.line, background: C.card, color: C.ink, borderRadius: 99, padding: "8px 16px", fontSize: 13.5, fontWeight: 600, minHeight: 38 }}>
        Loading more… ({left} left)
      </button>
    </div>
  );
}

function GuestReviews({ hotelId }) {
  const show = useShow();
  const [state, setState] = useState({ status: "loading", items: [] });
  const [ui, setUiCfg] = useState({ total: 0, first: 20, nav: "scroll" });
  const [shown, setShown] = useState(20);      // scrolling mode: how many are rendered so far
  const [page, setPage] = useState(0);         // pages mode: current page (0-based)
  const [lightbox, setLightbox] = useState(null);
  const sectionRef = React.useRef(null);
  const maxSeenRef = React.useRef(0);
  const load = () => {
    let alive = true;
    setState({ status: "loading", items: [] }); setPage(0); maxSeenRef.current = 0;
    Promise.all([
      fetchJson(`/api/hotels/${encodeURIComponent(hotelId)}/reviews${Track.pid ? `?pid=${encodeURIComponent(Track.pid)}` : ""}`),
      loadConfig(),
    ]).then(([rs, cfg]) => {
      if (!alive) return;
      const u = (cfg && cfg.reviewsUi) || {}; const uiCfg = { total: u.total || 0, first: Math.max(1, u.first || 20), nav: u.nav === "pages" ? "pages" : "scroll" };
      let items = (rs || []).filter(r => r.source === "quote" && r.text);
      if (uiCfg.total > 0) items = items.slice(0, uiCfg.total);
      setUiCfg(uiCfg); setShown(uiCfg.first);
      setState({ status: "ok", items });
      Track.reviewTotal(hotelId, items.length);
    }).catch(() => { if (alive) setState({ status: "error", items: [] }); });
    return () => { alive = false; Track.reviewsVisibleId = null; };
  };
  useEffect(load, [hotelId]);

  // time the reviews section is actually on screen
  useEffect(() => {
    const el = sectionRef.current; if (!el) return;
    const obs = new IntersectionObserver(es => { for (const e of es) Track.reviewsVisibleId = e.isIntersecting ? hotelId : (Track.reviewsVisibleId === hotelId ? null : Track.reviewsVisibleId); }, { threshold: 0.15 });
    obs.observe(el);
    return () => { obs.disconnect(); if (Track.reviewsVisibleId === hotelId) Track.reviewsVisibleId = null; };
  }, [hotelId, state.status]);

  // deepest review the participant scrolled to (1-based index over the whole list)
  const depthRefCb = (idx) => (el) => {
    if (!el) return;
    const obs = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting && idx + 1 > maxSeenRef.current) { maxSeenRef.current = idx + 1; Track.reviewDepth(hotelId, idx + 1); }
      }, { threshold: 0.5 });
    obs.observe(el);
  };

  // per-review thumbs
  const voteReview = (r, choice) => {
    if (!Track.pid) return;
    const next = r.myVote === choice ? null : choice;
    setState(st => ({ ...st, items: st.items.map(x => x.id === r.id ? { ...x, myVote: next || "" } : x) }));
    postJson("/api/review-vote", { pid: Track.pid, hotelId, reviewId: r.id, choice: next });
  };

  const items = state.items;
  const pageCount = Math.max(1, Math.ceil(items.length / ui.first));
  const visible = ui.nav === "pages" ? items.slice(page * ui.first, (page + 1) * ui.first) : items.slice(0, shown);
  const baseIndex = ui.nav === "pages" ? page * ui.first : 0;
  return (
    <div ref={sectionRef} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, margin: 0, color: C.ink }}>Guest reviews</h2>
        {state.status === "ok" && items.length > 0 && <span style={{ fontSize: 13, color: C.inkSoft }}>{items.length} review{items.length === 1 ? "" : "s"}</span>}
      </div>
      {state.status === "loading" && <div style={{ display: "flex", gap: 8, alignItems: "center", color: C.inkSoft, fontSize: 14 }}><Spinner /> Loading reviews…</div>}
      {state.status === "error" && <Status kind="error" onRetry={load}>Couldn't load reviews.</Status>}
      {state.status === "ok" && items.length === 0 && <div style={{ fontSize: 14, color: C.inkSoft }}>No guest reviews are available for this hotel.</div>}
      {state.status === "ok" && visible.map((r, i) => {
        const when = show("reviews.date") ? fmtMonth(r.month) : "";
        const stayed = show("reviews.stay") ? fmtMonth(r.dateVisited, true) : "";
        const tripType = show("reviews.tripType") ? r.tripType : "";
        const meta = [
          show("reviews.location") ? r.location : null,
          show("reviews.contributions") && r.contributions ? `${r.contributions.toLocaleString()} contribution${r.contributions === 1 ? "" : "s"}` : null,
          show("reviews.helpful") && r.helpful > 0 ? `${r.helpful.toLocaleString()} helpful vote${r.helpful === 1 ? "" : "s"}` : null,
        ].filter(Boolean);
        return (
          <article key={r.id || i} ref={depthRefCb(baseIndex + i)} style={{ padding: "18px 0", borderTop: i === 0 ? "none" : `1px solid ${C.line}` }}>
            {/* reviewer row: avatar · name "wrote a review Mon YYYY" · location • contributions • helpful votes */}
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
              {show("reviews.avatar") && <Avatar src={r.avatar} name={r.author} />}
              <div style={{ minWidth: 0 }}>
                <div className="wp-text" style={{ fontSize: 14.5, color: C.inkSoft, lineHeight: 1.4 }}>
                  <span style={{ color: C.ink, fontWeight: 700 }}>{r.author || "Guest"}</span>{when ? ` wrote a review ${when}` : ""}
                </div>
                {meta.length > 0 && <div className="wp-text" style={{ fontSize: 13.5, color: C.inkSoft, lineHeight: 1.4 }}>{meta.join(" • ")}</div>}
              </div>
            </div>
            {r.rating ? <div style={{ marginBottom: 6 }}><Buoys value={r.rating} size={14} /></div> : null}
            {r.title ? <div className="wp-text" style={{ fontWeight: 700, fontSize: 16, color: C.ink, marginBottom: 6 }}>{r.title}</div> : null}
            <p className="wp-text" style={{ fontSize: 14.5, lineHeight: 1.65, color: C.ink, margin: "0 0 10px", whiteSpace: "pre-line" }}>{r.text}</p>
            {(r.photos || []).length > 0 && show("reviews.photos") && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0 12px" }}>
                {r.photos.map((p, j) => (
                  <button key={j} type="button" onClick={() => setLightbox({ photos: r.photos, index: j })} className="wp-btn"
                    aria-label={p.caption ? `Open photo: ${p.caption}` : `Open photo ${j + 1}`}
                    style={{ padding: 0, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", width: 110, height: 110, background: C.sea, flex: "0 0 auto" }}>
                    <img src={p.src} alt={p.caption || ""} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </button>
                ))}
              </div>
            )}
            {(stayed || tripType) && (
              <div style={{ fontSize: 13, color: C.inkSoft, lineHeight: 1.7 }}>
                {stayed && <div>Date of stay: <span style={{ color: C.ink, fontWeight: 600 }}>{stayed}</span></div>}
                {tripType && <div>Trip type: <span style={{ color: C.ink, fontWeight: 600 }}>{tripType}</span></div>}
              </div>
            )}
            {show("reviews.vote") && Track.pid && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" onClick={() => voteReview(r, "up")} aria-pressed={r.myVote === "up"} className="wp-btn wp-ghost"
                  style={{ border: `1px solid ${r.myVote === "up" ? C.green : C.line}`, background: r.myVote === "up" ? C.green : C.card, color: r.myVote === "up" ? "#fff" : C.ink, borderRadius: 99, padding: "5px 12px", fontSize: 12.5, fontWeight: 600, minHeight: 32 }}>
                  👍 Helpful{r.myVote === "up" ? " ✓" : ""}
                </button>
                <button type="button" onClick={() => voteReview(r, "down")} aria-pressed={r.myVote === "down"} className="wp-btn wp-ghost"
                  style={{ border: `1px solid ${r.myVote === "down" ? "#B3261E" : C.line}`, background: r.myVote === "down" ? "#B3261E" : C.card, color: r.myVote === "down" ? "#fff" : C.ink, borderRadius: 99, padding: "5px 12px", fontSize: 12.5, fontWeight: 600, minHeight: 32 }}>
                  👎 Not helpful{r.myVote === "down" ? " ✓" : ""}
                </button>
              </div>
            )}
          </article>
        );
      })}
      {state.status === "ok" && ui.nav === "scroll" && shown < items.length && (
        <MoreSentinel key={shown} onMore={() => setShown(n => Math.min(items.length, n + ui.first))} left={items.length - shown} />
      )}
      {state.status === "ok" && ui.nav === "pages" && pageCount > 1 && (
        <nav aria-label="Review pages" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          <button type="button" disabled={page === 0} onClick={() => { setPage(p => p - 1); sectionRef.current?.scrollIntoView({ behavior: "smooth" }); }} className="wp-btn wp-ghost"
            style={{ border: `1px solid ${C.line}`, background: C.card, color: page === 0 ? C.inkSoft : C.ink, borderRadius: 99, padding: "7px 16px", fontSize: 13.5, fontWeight: 600, minHeight: 38, opacity: page === 0 ? 0.6 : 1 }}>‹ Previous</button>
          <span style={{ fontSize: 13, color: C.inkSoft }}>Page {page + 1} / {pageCount}</span>
          <button type="button" disabled={page >= pageCount - 1} onClick={() => { setPage(p => p + 1); sectionRef.current?.scrollIntoView({ behavior: "smooth" }); }} className="wp-btn wp-ghost"
            style={{ border: `1px solid ${C.line}`, background: C.card, color: page >= pageCount - 1 ? C.inkSoft : C.ink, borderRadius: 99, padding: "7px 16px", fontSize: 13.5, fontWeight: 600, minHeight: 38, opacity: page >= pageCount - 1 ? 0.6 : 1 }}>Next ›</button>
        </nav>
      )}
      {lightbox && <Lightbox photos={lightbox.photos} index={lightbox.index} onClose={() => setLightbox(null)} onIndex={i => setLightbox(l => ({ ...l, index: i }))} />}

    </div>
  );
}

/* ----------------------- city / hotel art ----------------------- */

/* Image with gradient placeholder. States: loading (gradient, image fading in),
   loaded, broken (falls back to the gradient skyline). */
function CityArt({ gradient, big, flat, image, imageFallback, className }) {
  const [a, b, c] = gradient || ["#1d3a5f", "#4a7ba6", "#dce7f0"];
  // src candidates: local copy first (if the server found one), then the original URL
  const sources = useMemo(() => [image, imageFallback].filter((u, i, arr) => u && arr.indexOf(u) === i), [image, imageFallback]);
  const [srcIdx, setSrcIdx] = useState(0);
  const [status, setStatus] = useState(sources.length ? "loading" : "none");
  useEffect(() => { setSrcIdx(0); setStatus(sources.length ? "loading" : "none"); }, [sources]);
  const src = sources[srcIdx];
  const onError = () => {
    if (srcIdx + 1 < sources.length) { setSrcIdx(srcIdx + 1); setStatus("loading"); }
    else setStatus("broken");
  };
  const showImg = src && status !== "broken";
  return (
    <div className={className} style={{
      position: "relative", overflow: "hidden",
      height: big ? 200 : 128,
      borderRadius: flat ? 0 : (big ? 14 : "10px 10px 0 0"),
      background: `linear-gradient(150deg, ${a} 0%, ${b} 58%, ${c} 100%)`,
    }}>
      {showImg && (
        <img src={src} alt="" loading="lazy" decoding="async"
          onLoad={() => setStatus("loaded")} onError={onError}
          style={{
            position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover",
            opacity: status === "loaded" ? 1 : 0, transition: "opacity .3s ease",
          }} />
      )}
      {(!showImg || status !== "loaded") && (
        <svg viewBox="0 0 400 80" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: big ? 80 : 54, opacity: 0.5 }}>
          <path d="M0,80 L0,50 L20,50 L20,34 L38,34 L38,50 L60,50 L60,22 L74,22 L74,50 L96,50 L96,40 L120,40 L120,18 L134,18 L134,40 L160,40 L160,52 L188,52 L188,30 L206,30 L206,52 L236,52 L236,38 L262,38 L262,20 L276,20 L276,38 L300,38 L300,50 L324,50 L324,28 L340,28 L340,50 L364,50 L364,42 L400,42 L400,80 Z" fill={c} opacity="0.85" />
        </svg>
      )}
    </div>
  );
}

function CityHero({ city, gradient }) {
  return <CityArt gradient={gradient} image={city && city.image} big />;
}

/* keyboard-accessible clickable card helper */
function cardProps(onOpen, label) {
  return {
    role: "button", tabIndex: 0, "aria-label": label,
    onClick: onOpen,
    onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } },
  };
}

/* ----------------------- home (city picker) ----------------------- */

function HomePage({ onOpenCity, favs, cities, hotels, pid }) {
  const countFor = (key) => hotels.filter(l => l.city === key).length;
  // city order is also a fixed random shuffle per participant (seeded by pid + "cities"),
  // so no city is always in the first position
  const shownCities = useMemo(
    () => seededShuffle(cities.filter(c => countFor(c.key) > 0).map(c => ({ ...c, id: c.key })), `${pid || "anon"}::cities`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cities, hotels, pid]
  );

  return (
    <div>
      <div style={{ textAlign: "center", padding: "34px 8px 26px" }}>
        <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(28px, 6vw, 46px)", fontWeight: 700, color: C.ink, margin: "0 0 18px", lineHeight: 1.15 }}>
          Find your perfect hotel
        </h1>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <BookmarkButton favs={favs} size="lg" />
        </div>
      </div>

      <div style={{ margin: "8px 2px 14px" }}>
        <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, margin: 0 }}>
          Choose a destination
        </h2>
      </div>

      {shownCities.length === 0 ? (
        <div style={{ textAlign: "center", color: C.inkSoft, padding: 40, fontSize: 14.5, background: C.card, border: `1px solid ${C.line}`, borderRadius: 12 }}>
          No destinations are available yet.
        </div>
      ) : (
        <div className="wp-city-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 18 }}>
          {shownCities.map(c => (
            <div key={c.key} className="wp-card" {...cardProps(() => onOpenCity(c.key), `Explore hotels in ${c.name}`)} style={{
              background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden",
            }}>
              <CityArt gradient={c.gradient} image={c.image} />
              <div style={{ padding: "14px 16px 16px" }}>
                <div className="wp-text" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 21, fontWeight: 700, color: C.ink }}>{c.name}</div>
                <div className="wp-text" style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 10 }}>{c.country}</div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <span style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>Explore</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------- city page (hotels in a city) ----------------------- */

/* Per-participant fixed shuffle.
   Each participant sees the hotels of a city in a random order that is
   fixed for that participant (same ID -> same order on every visit/device),
   while different participants get different orders. Seed = hash(pid + city).
   No SEO-first / rating / manual ordering is applied. */
function hashStr(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(list, seedStr) {
  // sort by id first so the input order never influences the result
  const arr = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rnd = mulberry32(hashStr(seedStr));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function CityPage({ cityKey, onBack, onOpen, votes, favs, cities, hotels: allHotels, pid, showAi = true }) {
  const city = cities.find(c => c.key === cityKey) || { name: cityKey, country: "", gradient: null };
  const [page, setPage] = useState(1);
  const [listUi, setListUi] = useState({ first: 20, nav: "pages" });
  const show = useShow();
  const [tut, setTut] = useState(null);   // steps array while the coachmark is active
  const [tutSkip, setTutSkip] = useState(true);
  useEffect(() => {
    if (!pid || localStorage.getItem("fah_tut") === "1") return;
    loadConfig().then(c => {
      if ((c.elements || {})["tutorial"] === false) return;
      const steps = Array.isArray(c.tutorialSteps) && c.tutorialSteps.length ? c.tutorialSteps : null;
      setTutSkip(c.tutorialSkip !== false);
      if (steps) setTimeout(() => setTut(steps), 400);   // wait for the first cards to render
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  const [shownCount, setShownCount] = useState(20);
  const [finished, setFinished] = useState(() => localStorage.getItem("fah_done") === "1");
  const [confirmExit, setConfirmExit] = useState(false);
  const finish = async () => {
    setConfirmExit(false); setFinished(true); localStorage.setItem("fah_done", "1");
    try { Track.flush && Track.flush(); } catch {}
    try { await postJson("/api/exit", { pid }); } catch {}
  };
  const [saveIds, setSaveIds] = useState([]);
  useEffect(() => { if (pid) fetchJson(`/api/saves?pid=${encodeURIComponent(pid)}`).then(a => setSaveIds(Array.isArray(a) ? a : [])).catch(() => {}); }, [pid]);
  const savesApi = useMemo(() => ({
    ids: saveIds,
    has: id => saveIds.includes(id),
    toggle: (id, source) => {
      if (!pid) return;
      setSaveIds(cur => {
        const on = !cur.includes(id);
        postJson("/api/save", { pid, hotelId: id, on, source });
        return on ? [...cur, id] : cur.filter(x => x !== id);
      });
    },
  }), [saveIds, pid]);
  useEffect(() => { loadConfig().then(c => { const u = (c && c.listUi) || {}; const cfg = { first: Math.max(1, u.first || 20), nav: u.nav === "scroll" ? "scroll" : "pages" }; setListUi(cfg); setShownCount(cfg.first); }); }, []);
  const PER_PAGE = listUi.first;

  const hotels = useMemo(() => {
    const list = allHotels.filter(l => l.city === cityKey);
    return seededShuffle(list, `${pid || "anon"}::${cityKey}`);
  }, [cityKey, allHotels, pid]);

  const totalPages = Math.max(1, Math.ceil(hotels.length / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const pageHotels = listUi.nav === "scroll" ? hotels.slice(0, shownCount) : hotels.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE);

  useEffect(() => { setPage(1); setShownCount(listUi.first); }, [cityKey, listUi.first]);
  useEffect(() => { if (listUi.nav === "pages") window.scrollTo({ top: 0, behavior: "smooth" }); }, [curPage]);

  return (
    <div>
      <button type="button" onClick={onBack} className="wp-btn wp-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.line}`, color: C.ink, fontWeight: 700, fontSize: 15, padding: "10px 18px", borderRadius: 99, marginBottom: 16, minHeight: 42 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        All destinations
      </button>

      <div style={{ marginBottom: 22 }}>
        <CityHero city={city} gradient={city.gradient} />
        <div style={{ marginTop: 16 }}>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 4 }}>
            {city.country}
          </div>
          <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(26px, 5.5vw, 40px)", fontWeight: 700, color: C.ink, margin: "0 0 12px", lineHeight: 1.1 }}>
            Hotels in {city.name}
          </h1>
          <BookmarkButton favs={favs} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 13, color: C.inkSoft }}>
          {hotels.length === 0 ? "No results"
            : listUi.nav === "scroll" ? `Showing ${Math.min(shownCount, hotels.length)} of ${hotels.length}`
            : `Showing ${(curPage - 1) * PER_PAGE + 1}–${Math.min(curPage * PER_PAGE, hotels.length)} of ${hotels.length}`}
        </span>
        {listUi.nav === "pages" && <span style={{ fontSize: 13, color: C.inkSoft }}>Page {curPage} / {totalPages}</span>}
      </div>

      {/* hotel list — order is a fixed random shuffle per participant */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {pageHotels.map(l => (
          <CityHotelRow key={l.id} l={l} onOpen={() => { Track.click(l.id); onOpen(l); }} votes={votes} showAi={showAi} />
        ))}
      </div>
      {hotels.length === 0 && (
        <div style={{ textAlign: "center", color: C.inkSoft, padding: 40, fontSize: 14.5, background: C.card, border: `1px solid ${C.line}`, borderRadius: 12 }}>
          No hotels are listed for {city.name} yet.
        </div>
      )}

      {tut && <Coachmark steps={tut} skippable={tutSkip} onDone={() => { setTut(null); localStorage.setItem("fah_tut", "1"); }} />}
      {listUi.nav === "pages" && totalPages > 1 && (
        <Pagination page={curPage} totalPages={totalPages} onGo={setPage} />
      )}
      {listUi.nav === "scroll" && shownCount < hotels.length && (
        <MoreSentinel key={shownCount} onMore={() => setShownCount(n => Math.min(hotels.length, n + listUi.first))} left={hotels.length - shownCount} />
      )}
    </div>
  );
}

/* pager: Prev / numbered pages (with ellipses) / Next */
function Pagination({ page, totalPages, onGo }) {
  const nums = [];
  const push = n => nums.push(n);
  const win = 1;
  push(1);
  if (page - win > 2) push("…l");
  for (let n = Math.max(2, page - win); n <= Math.min(totalPages - 1, page + win); n++) push(n);
  if (page + win < totalPages - 1) push("…r");
  if (totalPages > 1) push(totalPages);

  const btn = (active) => ({
    minWidth: 40, minHeight: 40, padding: "8px 12px", borderRadius: 8, fontSize: 13.5,
    border: `1px solid ${active ? C.ink : C.line}`, background: active ? C.ink : C.card,
    color: active ? C.paper : C.ink, fontWeight: active ? 700 : 500,
  });
  return (
    <nav aria-label="Pagination" style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 26, flexWrap: "wrap" }}>
      <button type="button" disabled={page === 1} onClick={() => onGo(page - 1)} className="wp-btn wp-ghost" style={btn(false)}>Prev</button>
      {nums.map((n, i) => typeof n === "string"
        ? <span key={n + i} aria-hidden="true" style={{ color: C.inkSoft, padding: "0 2px" }}>…</span>
        : <button type="button" key={n} onClick={() => onGo(n)} aria-current={n === page ? "page" : undefined}
            className={`wp-btn ${n === page ? "wp-primary" : "wp-ghost"}`} style={btn(n === page)}>{n}</button>
      )}
      <button type="button" disabled={page === totalPages} onClick={() => onGo(page + 1)} className="wp-btn wp-ghost" style={btn(false)}>Next</button>
    </nav>
  );
}

/* a horizontal result row.
   Shows the platform AI summary if the hotel has one (full text);
   otherwise falls back to the first real guest quote (fetched on demand,
   with loading / error / empty states). */
const DEFAULT_LAYOUT = { list: ["description", "ai", "vote", "priceCheck"], detail: ["description", "ai", "vote", "about", "reviews"] };
function useLayout() {
  const [lay, setLay] = useState(DEFAULT_LAYOUT);
  useEffect(() => { loadConfig().then(c => { if (c && c.layout) setLay({ list: c.layout.list || DEFAULT_LAYOUT.list, detail: c.layout.detail || DEFAULT_LAYOUT.detail }); }); }, []);
  return lay;
}

function CityHotelRow({ l, onOpen, votes, showAi = true }) {
  const show = useShow();
  const layout = useLayout();
  const heart = null;   // the Save action now sits where Like/Dislike used to be (block "save")
  // when the AI summary is hidden in the list (condition), nothing replaces it — no guest-quote fallback
  const [quote, setQuote] = useState({ status: l.seo || !showAi ? "skip" : "loading", data: null });
  const rowRef = useRef(null);

  const loadQuote = () => {
    let alive = true;
    setQuote({ status: "loading", data: null });
    fetchJson(`/api/hotels/${encodeURIComponent(l.id)}/reviews`)
      .then(rs => { if (alive) setQuote({ status: "done", data: (rs || []).find(r => r.source === "quote") || null }); })
      .catch(() => { if (alive) setQuote({ status: "error", data: null }); });
    return () => { alive = false; };
  };
  useEffect(() => {
    if (l.seo || !showAi) { setQuote({ status: "skip", data: null }); return; }
    return loadQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l.id, l.seo, showAi]);

  // list view + dwell: every time ≥50% of the card is in the viewport counts as a view,
  // and the time it stays there is credited as list dwell (see Track)
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !("IntersectionObserver" in window)) { Track.enter(l.id); return () => Track.leave(l.id); }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) Track.enter(l.id); else Track.leave(l.id); });
    }, { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); Track.leave(l.id); };
  }, [l.id]);

  const showSeo = Boolean(l.seo) && showAi;
  const badgeColor = showSeo ? C.buoy : C.green;
  const badge = (label, color) => (
    <span style={{
      flex: "0 0 auto", fontFamily: "'Roboto Mono', monospace", fontSize: 9.5,
      color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 5px", marginTop: 2,
    }}>{label}</span>
  );

  // official description from the CSV (shown plain, no label); ignore legacy rows where about was a copy of seo
  const desc = l.about && l.about.trim() && l.about.trim() !== (l.seo || "").trim() ? l.about.trim() : "";

  let body = null;
  if (showSeo) {
    body = <><AiBadge /><p className="wp-text" style={{ fontSize: 13, lineHeight: 1.55, color: C.inkSoft, margin: 0 }}>{l.seo}</p></>;
  } else if (quote.status === "loading") {
    body = <span style={{ fontSize: 12.5, color: C.inkSoft, display: "inline-flex", gap: 8, alignItems: "center" }}><Spinner /> Loading a guest quote…</span>;
  } else if (quote.status === "error") {
    body = (
      <span style={{ fontSize: 12.5, color: C.danger, display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        Couldn't load a guest quote.
        <button type="button" className="wp-btn wp-link" onClick={e => { e.stopPropagation(); loadQuote(); }} onKeyDown={e => e.stopPropagation()} style={{ color: C.danger, fontWeight: 600, fontSize: 12.5, minHeight: 32, padding: "4px 6px", margin: "-4px 0" }}>Try again</button>
      </span>
    );
  } else if (!showAi) {
    body = null;
  } else if (quote.data) {
    body = (
      <>
        {badge("GUEST", badgeColor)}
        <p className="wp-text" style={{ fontSize: 13, lineHeight: 1.55, color: C.inkSoft, margin: 0 }}>
          “{quote.data.text}”{quote.data.author && <span style={{ color: C.inkSoft, fontStyle: "italic" }}> — {quote.data.author}</span>}
        </p>
      </>
    );
  } else {
    body = <span style={{ fontSize: 12.5, color: C.inkSoft }}>No summary or guest quote available for this hotel.</span>;
  }

  return (
    <div ref={rowRef} className="wp-card wp-row" {...cardProps(onOpen, `Open ${l.name}`)} style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", position: "relative",
    }}>
      {heart}
      <div style={{ position: "relative" }}>
        <CityArt className="wp-art" gradient={l.gradient} image={l.image} imageFallback={l.imageRemote} />
      </div>
      <div className="wp-text" style={{ padding: "14px 18px", minWidth: 0 }}>
        <div className="wp-text" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 18, fontWeight: 700, color: C.ink, lineHeight: 1.25 }}>{l.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 10px", flexWrap: "wrap" }}>
          <Buoys value={l.rating} size={12} />
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{l.rating.toFixed(1)}</span>
          {show("list.reviewCount") && <span style={{ fontSize: 12.5, color: C.inkSoft }}>({(l.reviewCount || 0).toLocaleString()})</span>}
        </div>
        {layout.list.map(k => {
          if (k === "description") return desc && show("list.description") ? <p key={k} className="wp-text" style={{ fontSize: 13, lineHeight: 1.6, color: C.ink, margin: "0 0 10px" }}>{firstSentence(desc)}</p> : null;
          if (k === "ai") return body ? <div key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10 }}>{body}</div> : null;
          if (k === "vote") return votes && show("list.vote") ? <div key={k} style={{ margin: "2px 0 10px" }}><LikeDislike hotelId={l.id} {...votes} source="list" /></div> : null;
          if (k === "save") return (show("list.save") || show("list.vote")) && Track.pid ? (
            <div key={k} style={{ margin: "2px 0 10px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {show("list.save") && <SavePill hotelId={l.id} source="list" size="lg" />}
              {votes && <LikeDislike hotelId={l.id} {...votes} source="list" size="lg" only="down" />}
            </div>
          ) : null;
          if (k === "priceCheck") return (show("list.price") && l.price) || show("list.check") ? (
            <div key={k} style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginTop: 4, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
              {show("list.price") && l.price ? (
                <div>
                  <div style={{ fontSize: 12, color: C.inkSoft }}>from</div>
                  <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 20, fontWeight: 700, color: C.ink, lineHeight: 1.1 }}>{l.price.replace(/^from\s*/i, "")}</div>
                </div>
              ) : <span />}
              {show("list.check") && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }} onKeyDown={e => e.stopPropagation()} className="wp-btn wp-accent"
                  style={{ background: C.green, color: "#fff", border: "none", borderRadius: 99, padding: "10px 20px", fontSize: 14, fontWeight: 700, minHeight: 42, flex: "0 0 auto" }}>
                  Check this hotel
                </button>
              )}
            </div>
          ) : null;
          return null;
        })}
      </div>
    </div>
  );
}

/* ----------------------- app shell ----------------------- */

/* favorites hook: loads this participant's favorites, exposes the site toggle
   with pending / error / saved state */
function useFavorites(pid) {
  const [siteFav, setSiteFav] = useState(false);
  const [sitePending, setSitePending] = useState(false);
  const [siteError, setSiteError] = useState(null);
  const [siteSaved, setSiteSaved] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!pid) return;
    let alive = true;
    fetchJson(`/api/fav?pid=${encodeURIComponent(pid)}`)
      .then(d => { if (alive && d) setSiteFav(Boolean(d.siteFav)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [pid]);

  const toggleSite = async () => {
    if (sitePending) return;
    const next = !siteFav;
    setSiteFav(next); setSitePending(true); setSiteError(null); setSiteSaved(false);
    try {
      await postJsonStrict("/api/fav/site", { pid, on: next });
      setSiteSaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSiteSaved(false), 1800);
    } catch (e) {
      setSiteFav(!next);
      setSiteError("Couldn't update your bookmark. Check your connection and try again.");
    } finally {
      setSitePending(false);
    }
  };
  return { siteFav, sitePending, siteError, siteSaved, toggleSite };
}

/* opening modal that asks for the participant id.
   States: default (button disabled until an ID is typed), validation error,
   submitting (registering the ID with the server), server error with retry
   or continue-offline, success (modal closes). */
const PID_RE = /^[A-Za-z0-9_-]{1,32}$/;
function ParticipantModal({ onSubmit }) {
  const [step, setStep] = useState("welcome");     // welcome → id
  const [welcome, setWelcome] = useState({ status: "loading", text: "" });
  const [agree, setAgree] = useState(false);
  const [val, setVal] = useState("");
  const [assigned, setAssigned] = useState("");
  useEffect(() => {
    // 1) ?pid=P0007 in the link (e.g. from Qualtrics) wins; 2) then the number this browser already holds; 3) else ask the server for the next one
    const fromUrl = new URLSearchParams(window.location.search).get("pid");
    if (fromUrl) { const v = fromUrl.trim().slice(0, 64); localStorage.setItem("fah_assigned", v); setAssigned(v); setVal(cur => cur || v); return; }
    const kept = localStorage.getItem("fah_assigned");
    if (kept) { setAssigned(kept); setVal(v => v || kept); return; }
    fetchJson("/api/assign-id").then(d => { if (d && d.pid) { localStorage.setItem("fah_assigned", d.pid); setAssigned(d.pid); setVal(v => v || d.pid); } }).catch(() => {});
  }, []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [serverFail, setServerFail] = useState(false);

  const loadWelcome = () => {
    setWelcome({ status: "loading", text: "" });
    fetchJson("/api/settings/welcome")
      .then(d => setWelcome({ status: "ok", text: d.text || "" }))
      .catch(() => setWelcome({ status: "error", text: "" }));
  };
  useEffect(loadWelcome, []);

  const submit = async () => {
    const v = val.trim();
    if (!v) { setError("Enter your participant ID to continue."); return; }
    if (!PID_RE.test(v)) { setError("Use letters, numbers, - or _ only (up to 32 characters)."); return; }
    setError(null); setServerFail(false); setBusy(true);
    try {
      await postJsonStrict("/api/track/session", { pid: v, ms: 0 });
      await postJsonStrict("/api/track/consent", { pid: v });
      onSubmit(v);
    } catch (e) {
      setServerFail(true);
      setError("Couldn't reach the study server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const invalid = Boolean(error);
  const paragraphs = welcome.text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="wp-modal-title" style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "rgba(18,43,51,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{ background: C.card, borderRadius: 16, padding: "26px 24px", maxWidth: step === "welcome" ? 620 : 420, width: "100%", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 60px rgba(0,0,0,0.3)" }}>
        {step === "welcome" ? (
          <>
            <h2 id="wp-modal-title" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, margin: "0 0 12px" }}>
              Before you start
            </h2>
            <div style={{ overflowY: "auto", flex: "1 1 auto", minHeight: 80, paddingRight: 4, marginBottom: 16 }}>
              {welcome.status === "loading" && <div style={{ display: "flex", gap: 8, alignItems: "center", color: C.inkSoft, fontSize: 14 }}><Spinner /> Loading…</div>}
              {welcome.status === "error" && <Status kind="error" onRetry={loadWelcome}>Couldn't load the instructions.</Status>}
              {welcome.status === "ok" && paragraphs.map((p, i) => (
                <p key={i} className="wp-text" style={{ fontSize: 14.5, lineHeight: 1.65, color: C.ink, margin: "0 0 12px", whiteSpace: "pre-line" }}>{p}</p>
              ))}
            </div>
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, color: C.ink, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} disabled={welcome.status !== "ok"} style={{ width: 18, height: 18, marginTop: 1, accentColor: C.ink }} />
              <span>I have read the information above and agree to take part.</span>
            </label>
            <button type="button" onClick={() => setStep("id")} disabled={!agree || welcome.status !== "ok"} className="wp-btn wp-primary" style={{
              width: "100%", minHeight: 46, padding: "12px", fontSize: 15, fontWeight: 600, borderRadius: 10, border: "none", background: C.ink, color: "#fff",
            }}>
              Continue
            </button>
          </>
        ) : (
          <>
            <h2 id="wp-modal-title" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, margin: "0 0 8px" }}>
              Enter your participant ID
            </h2>
            <p style={{ fontSize: 14.5, color: C.inkSoft, lineHeight: 1.6, margin: "0 0 12px" }}>
              Your browsing and actions on this site are recorded under this ID for research analysis.
            </p>
            {assigned && (
              <div style={{ background: "#F2F7F5", border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 14px", margin: "0 0 14px", fontSize: 14, color: C.ink, lineHeight: 1.6 }}>
                Your participant number is <b style={{ fontFamily: "'Roboto Mono', monospace" }}>{assigned}</b>.
                Please enter this same number in your Qualtrics survey and on Prolific.
              </div>
            )}
            <label htmlFor="wp-pid" style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Participant ID</label>
            <input id="wp-pid" autoFocus value={val} disabled={busy}
              onChange={e => { setVal(e.target.value); if (error) setError(null); }}
              onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="e.g. P001" autoComplete="off" spellCheck={false}
              aria-invalid={invalid} aria-describedby={invalid ? "wp-pid-error" : undefined}
              className={`wp-input${invalid ? " is-error" : ""}`}
              style={{ width: "100%", padding: "12px 14px", fontSize: 16, borderRadius: 10, border: `1.5px solid ${C.line}`, color: C.ink, marginBottom: error ? 6 : 16, background: busy ? C.paper : C.card }} />
            {error && <div id="wp-pid-error" role="alert" className="wp-fade" style={{ fontSize: 13, color: C.danger, margin: "0 0 14px" }}>{error}</div>}
            <button type="button" onClick={submit} disabled={!val.trim() || busy} aria-busy={busy} className="wp-btn wp-primary" style={{
              width: "100%", minHeight: 46, padding: "12px", fontSize: 15, fontWeight: 600, borderRadius: 10, border: "none",
              background: C.ink, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}>
              {busy ? <><Spinner /> Starting…</> : serverFail ? "Try again" : "Start"}
            </button>
            {serverFail && (
              <button type="button" onClick={() => onSubmit(val.trim())} className="wp-btn wp-link" style={{ marginTop: 12, width: "100%", fontSize: 13, color: C.inkSoft, fontWeight: 600 }}>
                Continue anyway (activity may not be recorded)
              </button>
            )}
            <button type="button" onClick={() => setStep("welcome")} className="wp-btn wp-link" style={{ marginTop: 12, width: "100%", fontSize: 13, color: C.inkSoft }}>
              Back to the information page
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* non-blocking banner for data-loading problems */
function DataBanner({ state, onRetry, onDismiss }) {
  if (state.status !== "error") return null;
  return (
    <div role="alert" className="wp-fade" style={{
      background: C.dangerBg, color: C.danger, border: `1px solid ${C.danger}33`, borderRadius: 10,
      padding: "10px 14px", fontSize: 13.5, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16,
    }}>
      <span style={{ flex: "1 1 200px" }}>Live hotel data couldn't be loaded — showing the built-in copy. Votes and bookmarks may not save until the connection is back.</span>
      <button type="button" onClick={onRetry} disabled={state.retrying} aria-busy={state.retrying} className="wp-btn wp-ghost" style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.danger}`, background: C.card, color: C.danger, fontWeight: 600, fontSize: 13, display: "inline-flex", gap: 6, alignItems: "center" }}>
        {state.retrying ? <><Spinner /> Retrying…</> : "Retry"}
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="wp-btn wp-link" style={{ color: C.danger, fontSize: 18, lineHeight: 1 }}>×</button>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState({ name: "home" });
  const votes = useVotes();

  // participant id (research tracking) — persisted so a refresh keeps the same participant
  const [pid, setPid] = useState(() => {
    try { return localStorage.getItem("fah_pid") || null; } catch { return null; }
  });
  const favs = useFavorites(pid);

  useEffect(() => {
    if (pid) Track.start(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live data from the API, falling back to bundled seed data.
  const [cities, setCities] = useState(SEED_CITIES);
  // bundled fallback data: drop remote image URLs so the page never loads
  // images from a third-party host (the server decides what `image` is)
  const [hotels, setHotels] = useState(() => SEED_LISTINGS.map(h => ({ ...h, image: "", images: [], imageRemote: "" })));
  const [dataState, setDataState] = useState({ status: "loading", retrying: false });
  // experimental condition: AI summary switches + page-element switches (admin → Study settings)
  const [ai, setAi] = useState({ search: true, product: true });
  const [ui, setUi] = useState({});
  const [finished, setFinished] = useState(() => localStorage.getItem("fah_done") === "1");
  const [confirmExit, setConfirmExit] = useState(false);
  const finish = async () => {
    setConfirmExit(false); setFinished(true); localStorage.setItem("fah_done", "1");
    try { Track.flush && Track.flush(); } catch {}
    try { await postJson("/api/exit", { pid }); } catch {}
  };
  const [saveIds, setSaveIds] = useState([]);
  useEffect(() => { if (pid) fetchJson(`/api/saves?pid=${encodeURIComponent(pid)}`).then(a => setSaveIds(Array.isArray(a) ? a : [])).catch(() => {}); }, [pid]);
  const savesApi = useMemo(() => ({
    ids: saveIds,
    has: id => saveIds.includes(id),
    toggle: (id, source) => {
      if (!pid) return;
      setSaveIds(cur => {
        const on = !cur.includes(id);
        postJson("/api/save", { pid, hotelId: id, on, source });
        return on ? [...cur, id] : cur.filter(x => x !== id);
      });
    },
  }), [saveIds, pid]);
  useEffect(() => { loadConfig().then(c => { if (c && typeof c.aiSearch === "boolean") setAi({ search: c.aiSearch, product: c.aiProduct }); if (c && c.elements) setUi({ ...c.elements, __goodbye: (c.goodbye || "").trim(), __return: (c.returnUrl || "").trim() }); }).catch(() => {}); }, []);

  const loadData = async (isRetry = false) => {
    setDataState(s => ({ status: isRetry ? "error" : "loading", retrying: isRetry }));
    try {
      const [c, h] = await Promise.all([fetchJson("/api/cities"), fetchJson("/api/hotels")]);
      if (c?.length && h?.length) { setCities(c); setHotels(h); }
      setDataState({ status: "ok", retrying: false });
    } catch (e) {
      setDataState({ status: "error", retrying: false });
    }
  };
  useEffect(() => { loadData(false); }, []);

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  /* ---- navigation with browser history ----
     Every forward step (home → city → detail) pushes a history entry, so the
     platform's own "back" works: swipe right from the left edge on iPhone /
     Android, two-finger swipe on a Mac trackpad, the browser back button and
     the Android back button. The in-app Back buttons call history.back() so
     the two never get out of sync. */
  const depthRef = useRef(0);
  const go = (next) => { depthRef.current += 1; window.history.pushState({ page: next, depth: depthRef.current }, ""); setPage(next); };
  const back = () => {
    if (depthRef.current > 0) window.history.back();
    else setPage(prev => prev.name === "detail" && prev.from === "city" ? { name: "city", cityKey: prev.cityKey } : { name: "home" });
  };
  useEffect(() => {
    // keep the current view across a page refresh (history.state survives reloads)
    const st = window.history.state;
    if (st && st.page && st.page.name) { depthRef.current = st.depth || 0; setPage(st.page); }
    else window.history.replaceState({ page: { name: "home" }, depth: 0 }, "");
    const onPop = (e) => {
      const st = e.state || { page: { name: "home" }, depth: 0 };
      depthRef.current = st.depth || 0;
      setPage(st.page || { name: "home" });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // in-page swipe right (touch anywhere, not just the screen edge) → back one level
  useEffect(() => {
    let sx = 0, sy = 0, active = false;
    const onStart = (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; active = true; };
    const onEnd = (e) => {
      if (!active) return; active = false;
      const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
      if (dx > 90 && Math.abs(dy) < 60 && Math.abs(dx) > Math.abs(dy) * 2) back();
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => { window.removeEventListener("touchstart", onStart); window.removeEventListener("touchend", onEnd); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // trackpad: two-finger swipe right → back one level (for browsers that don't map it to history)
  useEffect(() => {
    let acc = 0, fired = false;
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      acc += e.deltaX;
      if (acc > 0) acc = 0;
      if (acc < -110 && !fired) {
        fired = true;
        if (depthRef.current > 0) back();
        setTimeout(() => { fired = false; acc = 0; }, 800);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startSession = (id) => {
    try { localStorage.setItem("fah_pid", id); } catch {}
    setPid(id); Track.start(id);
  };

  const navBtn = (active) => ({
    background: "none", border: "none", fontSize: 13.5, minHeight: 36, padding: "6px 8px", borderRadius: 8,
    color: active ? C.ink : C.inkSoft, fontWeight: active ? 600 : 400,
  });

  return (
    <UiContext.Provider value={ui}>
    <SavesContext.Provider value={savesApi}>
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: "'Roboto', sans-serif", color: C.ink }}>
      <style>{GLOBAL_CSS}</style>
      {!pid && <ParticipantModal onSubmit={startSession} />}
      <header style={{
        position: "sticky", top: 0, zIndex: 10, background: "rgba(247,249,248,0.92)",
        backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`,
      }}>
        <div className="wp-header" style={{ maxWidth: 1080, margin: "0 auto", padding: "10px 16px" }}>
          <button type="button" onClick={() => page.name !== "home" && go({ name: "home" })} className="wp-btn wp-link" aria-label="Find a Hotel — home" style={{ display: "flex", alignItems: "center", minHeight: 36 }}>
            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 20, fontWeight: 700, color: C.ink, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>Find a Hotel</span>
          </button>
          <nav style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
            {pid && (
              <span className="wp-text" title={`Participant ${pid}`} style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 12, color: C.inkSoft, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ID {pid}
              </span>
            )}



          </nav>
        </div>
      </header>

      <main className="wp-main" style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 20px 60px" }}>
        <DataBanner state={dataState} onRetry={() => loadData(true)} onDismiss={() => setDataState({ status: "ok", retrying: false })} />
        {page.name === "home" && (
          <HomePage
            pid={pid}
            favs={favs}
            cities={cities}
            hotels={hotels}
            onOpenCity={key => go({ name: "city", cityKey: key })}
          />
        )}
        {page.name === "city" && (
          <CityPage
            cityKey={page.cityKey}
            pid={pid}
            showAi={ai.search}
            votes={votes}
            favs={favs}
            cities={cities}
            hotels={hotels}
            onBack={back}
            onOpen={l => go({ name: "detail", listing: l, from: "city", cityKey: page.cityKey })}
          />
        )}
        {page.name === "detail" && (
          <DetailPage
            listing={page.listing}
            votes={votes}
            showAi={ai.product}
            onBack={back}
          />
        )}
      </main>
      {confirmExit && !finished && (
        <ExitReview pid={pid} saves={savesApi} onCancel={() => setConfirmExit(false)} onFinish={finish} />
      )}
      {false && (
        <div role="dialog" aria-modal="true" aria-label="Finish study" style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(18,43,51,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: C.card, borderRadius: 14, padding: 26, maxWidth: 440, width: "100%", boxShadow: "0 18px 60px rgba(18,43,51,.4)" }}>
            <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 20, fontWeight: 700, margin: "0 0 10px", color: C.ink }}>Finish and exit?</h2>
            <p style={{ fontSize: 14.5, lineHeight: 1.6, color: C.inkSoft, margin: "0 0 18px" }}>
              This ends your browsing session. You won't be able to return to the hotels afterwards.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" onClick={() => setConfirmExit(false)} className="wp-btn wp-ghost" style={{ border: `1px solid ${C.line}`, background: C.card, color: C.ink, borderRadius: 99, padding: "10px 18px", fontWeight: 600, minHeight: 42 }}>Keep browsing</button>
              <button type="button" onClick={finish} className="wp-btn" style={{ background: C.ink, color: "#fff", border: "none", borderRadius: 99, padding: "10px 20px", fontWeight: 700, minHeight: 42 }}>Finish study</button>
            </div>
          </div>
        </div>
      )}
      {finished && (
        <div role="dialog" aria-modal="true" aria-label="Thank you" style={{ position: "fixed", inset: 0, zIndex: 1300, background: C.paper, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ textAlign: "center", maxWidth: 520 }}>
            <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 30, fontWeight: 700, color: C.ink, marginBottom: 12 }}>Thank you!</div>
            <p className="wp-text" style={{ fontSize: 16, lineHeight: 1.7, color: C.inkSoft, whiteSpace: "pre-line" }}>
              {ui.__goodbye || "You have finished this part of the study. Your session has been recorded.\nYou can now close this window and return to the questionnaire."}
            </p>
            {pid && <div style={{ marginTop: 14, fontFamily: "'Roboto Mono', monospace", fontSize: 13, color: C.inkSoft }}>Participant ID: {pid}</div>}
            {ui.__return && (
              <a href={`${ui.__return}${ui.__return.includes("?") ? "&" : "?"}pid=${encodeURIComponent(pid || "")}`}
                 style={{ display: "inline-block", marginTop: 22, background: C.green, color: "#fff", borderRadius: 99, padding: "13px 26px", fontWeight: 700, fontSize: 15.5, textDecoration: "none" }}>
                Continue to the questionnaire →
              </a>
            )}
          </div>
        </div>
      )}
      {pid && !finished && ui["exit.button"] !== false && (
        <button id="wp-finish" type="button" onClick={() => setConfirmExit(true)} aria-label="Finish study"
          className="wp-btn"
          style={{ position: "fixed", right: 18, bottom: 74, zIndex: 900, display: "inline-flex", alignItems: "center", justifyContent: "center",
                   background: "#B3261E", color: "#fff", border: "none", borderRadius: 99, padding: "12px 18px", fontWeight: 700, fontSize: 14.5,
                   boxShadow: "0 6px 20px rgba(179,38,30,.35)", minHeight: 46, minWidth: 132 }}>
          Finish study
        </button>
      )}
      <SavesFab allHotels={hotels} onOpen={l => { Track.click(l.id); go({ name: "detail", listing: l, from: "saves", cityKey: l.city }); }} />
    </div>
    </SavesContext.Provider>
    </UiContext.Provider>
  );
}
