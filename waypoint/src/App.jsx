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
    const b = this.buffer[hotelId] || (this.buffer[hotelId] = { list_ms: 0, detail_ms: 0 });
    b[type] += ms;
  },
  // send buffered dwell; `beacon` = page is closing, use sendBeacon so the request survives unload
  flush(beacon = false) {
    if (!this.pid) return;
    const items = [];
    for (const [hotelId, b] of Object.entries(this.buffer)) {
      if (b.list_ms >= 250) items.push({ hotelId, type: "list_ms", n: Math.round(b.list_ms) });
      if (b.detail_ms >= 250) items.push({ hotelId, type: "detail_ms", n: Math.round(b.detail_ms) });
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
.wp-accent:not(:disabled):hover { background: #D0451F !important; box-shadow: 0 4px 12px rgba(232,84,47,.25); }
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

/* ----------------------- atoms ----------------------- */

function Buoys({ value, size = 14 }) {
  const rings = [];
  for (let i = 1; i <= 5; i++) {
    const fill = Math.min(Math.max(value - (i - 1), 0), 1);
    rings.push(
      <span key={i} style={{ position: "relative", width: size, height: size, display: "inline-block" }}>
        <span style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `${Math.max(2, size * 0.22)}px solid ${C.buoyDim}` }} />
        <span style={{
          position: "absolute", inset: 0, borderRadius: "50%",
          border: `${Math.max(2, size * 0.22)}px solid ${C.buoy}`,
          clipPath: fill >= 1 ? "none" : `inset(0 ${100 - fill * 100}% 0 0)`,
          opacity: fill > 0 ? 1 : 0,
        }} />
      </span>
    );
  }
  return <span aria-label={`${value} out of 5`} style={{ display: "inline-flex", gap: size * 0.28, alignItems: "center", flex: "0 0 auto" }}>{rings}</span>;
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
function firstSentence(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const re = /[.!?]+(?=\s|$)/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(0, m.index);
    if (m[0] === "." && (ABBR.test(before) || /\d$/.test(before) && /^\d/.test(t.slice(m.index + 1)))) continue;
    return t.slice(0, m.index + m[0].length);
  }
  return t;
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

function LikeDislike({ hotelId, mine, pending, errors, saved, vote, size = "sm", stop = true, source = "list" }) {
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
        <button type="button" onClick={handle("up")} disabled={busy} aria-busy={busy} aria-pressed={my === "up"}
          className={`wp-btn wp-vote${my === "up" ? " is-up" : ""}`} style={btn(my === "up", C.green)}>
          {busy && lastChoice.current === "up" ? <Spinner /> : null}
          <span>{my === "up" ? "Liked" : "Like this hotel"}</span>
        </button>
        <button type="button" onClick={handle("down")} disabled={busy} aria-busy={busy} aria-pressed={my === "down"}
          className={`wp-btn wp-vote${my === "down" ? " is-down" : ""}`} style={btn(my === "down", C.buoy)}>
          {busy && lastChoice.current === "down" ? <Spinner /> : null}
          <span>{my === "down" ? "Disliked" : "Dislike this hotel"}</span>
        </button>
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
  useEffect(() => { Track.openDetail(listing.id); return () => Track.closeDetail(listing.id); }, [listing.id]);
  return (
    <div>
      <button type="button" onClick={onBack} className="wp-btn wp-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.line}`, color: C.ink, fontWeight: 700, fontSize: 15, padding: "10px 18px", borderRadius: 99, marginBottom: 16, minHeight: 42 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        Back
      </button>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", marginBottom: 20 }}>
        <CityArt gradient={listing.gradient} image={listing.image} imageFallback={listing.imageRemote} big flat />
        <div className="wp-detail-pad" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 6 }}>
            {listing.type} · {listing.cityName || listing.city}
          </div>
          <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(23px, 5vw, 34px)", fontWeight: 700, margin: "0 0 6px", color: C.ink, lineHeight: 1.15 }}>
            {listing.name}
          </h1>
          <div className="wp-text" style={{ fontSize: 14.5, color: C.inkSoft, marginBottom: 12, lineHeight: 1.5 }}>{listing.place} · {listing.price}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 700, color: C.ink }}>{listing.rating.toFixed(1)}</span>
            <Buoys value={listing.rating} size={16} />
            <span style={{ fontSize: 14, color: C.inkSoft }}>{(listing.reviewCount || 0).toLocaleString()} traveller reviews</span>
          </div>
          {listing.tags.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
              {listing.tags.map(t => <Tag key={t}>{t}</Tag>)}
            </div>
          )}
          {(() => {
            const desc = listing.about && listing.about.trim() && listing.about.trim() !== (listing.seo || "").trim() ? listing.about.trim() : "";
            return (
              <>
                {desc && <p className="wp-text" style={{ fontSize: 15, lineHeight: 1.7, color: C.ink, margin: "0 0 14px", maxWidth: 720 }}>{desc}</p>}
                {listing.seo && showAi && (
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "0 0 18px", maxWidth: 720 }}>
                    <AiBadge />
                    <p className="wp-text" style={{ fontSize: 15, lineHeight: 1.7, color: C.inkSoft, margin: 0 }}>{listing.seo}</p>
                  </div>
                )}
              </>
            );
          })()}
          {votes && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap", paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600, paddingTop: 8 }}>Would you stay here?</span>
              <LikeDislike hotelId={listing.id} {...votes} size="lg" stop={false} source="detail" />
            </div>
          )}
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 28 }}>
        <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, margin: "0 0 14px", color: C.ink }}>Amenities</h2>
        {listing.amenities.length > 0 ? (
          <div className="wp-amenities" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "8px 14px" }}>
            {listing.amenities.map(a => <div key={a} className="wp-text" style={{ fontSize: 13.5, color: C.inkSoft }}>· {a}</div>)}
          </div>
        ) : (
          <div style={{ fontSize: 13.5, color: C.inkSoft }}>No amenity details are listed for this hotel.</div>
        )}
      </div>
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
  const PER_PAGE = 20;

  const hotels = useMemo(() => {
    const list = allHotels.filter(l => l.city === cityKey);
    return seededShuffle(list, `${pid || "anon"}::${cityKey}`);
  }, [cityKey, allHotels, pid]);

  const totalPages = Math.max(1, Math.ceil(hotels.length / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const pageHotels = hotels.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE);

  useEffect(() => { setPage(1); }, [cityKey]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [curPage]);

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
          {hotels.length > 0
            ? `Showing ${(curPage - 1) * PER_PAGE + 1}–${Math.min(curPage * PER_PAGE, hotels.length)} of ${hotels.length}`
            : "No results"}
        </span>
        <span style={{ fontSize: 13, color: C.inkSoft }}>Page {curPage} / {totalPages}</span>
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

      {totalPages > 1 && (
        <Pagination page={curPage} totalPages={totalPages} onGo={setPage} />
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
function CityHotelRow({ l, onOpen, votes, showAi = true }) {
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
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden",
    }}>
      <div style={{ position: "relative" }}>
        <CityArt className="wp-art" gradient={l.gradient} image={l.image} imageFallback={l.imageRemote} />
      </div>
      <div className="wp-text" style={{ padding: "14px 18px", minWidth: 0 }}>
        <div className="wp-text" style={{ fontFamily: "'Poppins', sans-serif", fontSize: 18, fontWeight: 700, color: C.ink, lineHeight: 1.25 }}>{l.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 10px", flexWrap: "wrap" }}>
          <Buoys value={l.rating} size={12} />
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{l.rating.toFixed(1)}</span>
          <span style={{ fontSize: 12.5, color: C.inkSoft }}>({(l.reviewCount || 0).toLocaleString()})</span>
          <span className="wp-text" style={{ fontSize: 12, color: C.inkSoft }}>· {l.price}</span>
        </div>
        {desc && <p className="wp-text" style={{ fontSize: 13, lineHeight: 1.6, color: C.ink, margin: "0 0 10px" }}>{firstSentence(desc)}</p>}
        {body && <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>{body}</div>}
        {votes && (
          <div style={{ marginTop: 12 }}>
            <LikeDislike hotelId={l.id} {...votes} source="list" />
          </div>
        )}
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
            <p style={{ fontSize: 14.5, color: C.inkSoft, lineHeight: 1.6, margin: "0 0 18px" }}>
              Your browsing and actions on this site are recorded under this ID for research analysis.
            </p>
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
  // experimental condition: AI summary switches for the search (list) page and the product (detail) page
  const [ai, setAi] = useState({ search: true, product: true });
  useEffect(() => { fetchJson("/api/config").then(c => { if (c && typeof c.aiSearch === "boolean") setAi({ search: c.aiSearch, product: c.aiProduct }); }).catch(() => {}); }, []);

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
    window.history.replaceState({ page: { name: "home" }, depth: 0 }, "");
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
            <button type="button" onClick={() => page.name !== "home" && go({ name: "home" })} className="wp-btn wp-ghost" style={navBtn(page.name === "home")}>Destinations</button>
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
    </div>
  );
}
