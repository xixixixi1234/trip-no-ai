import React, { useState, useEffect, useMemo } from "react";
import { CITIES as SEED_CITIES, CITY_LISTINGS as SEED_LISTINGS, CITY_REVIEWS as SEED_REVIEWS } from "./cities.js";

/* Data loads live from the API (so admin CSV imports show up). The bundled
   cities.js is only a fallback for `npm run dev` without the API server. */
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function postJson(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
}

/* ============================================================
   Participant research tracking (module-level singleton)
   pid comes from the opening modal; all activity is attributed to it.
   ============================================================ */
const Track = {
  pid: null,
  seenSent: new Set(),   // hotelIds already counted as "seen" this session
  start(pid) {
    this.pid = pid;
    this.seenSent = new Set();
    // heartbeat: report dwell time every 5s while the tab is visible
    if (this._hb) clearInterval(this._hb);
    let last = Date.now();
    this._hb = setInterval(() => {
      if (!this.pid || document.hidden) { last = Date.now(); return; }
      const now = Date.now();
      const ms = now - last; last = now;
      if (ms > 0 && ms < 60000) postJson("/api/track/session", { pid: this.pid, ms });
    }, 5000);
    // register + flush remaining time on unload
    postJson("/api/track/session", { pid, ms: 0 });
    window.addEventListener("visibilitychange", () => { last = Date.now(); });
  },
  seen(hotelId) {
    if (!this.pid || this.seenSent.has(hotelId)) return;
    this.seenSent.add(hotelId);
    postJson("/api/track/event", { pid: this.pid, hotelId, type: "seen" });
  },
  click(hotelId) {
    if (!this.pid) return;
    postJson("/api/track/event", { pid: this.pid, hotelId, type: "click" });
  },
};

/* ============================================================
   WAYPOINT — honest travel reviews
   Coastal design: ink-teal, paper white, life-buoy orange.
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
};

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
  return <span style={{ display: "inline-flex", gap: size * 0.28, alignItems: "center" }}>{rings}</span>;
}

/* Per-browser voter id (module-level; stable for the page's lifetime). */
let VOTER_ID = null;
function getVoterId() {
  // votes are attributed to the participant id when available (so the admin
  // can count each participant's upvotes); fall back to a random id otherwise
  if (Track.pid) return Track.pid;
  if (!VOTER_ID) VOTER_ID = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  return VOTER_ID;
}

/* Shared vote state: tallies for every hotel + this browser's own choices. */
function useVotes() {
  const [tallies, setTallies] = useState({});   // { hotelId: {up,down} }
  const [mine, setMine] = useState({});         // { hotelId: 'up'|'down' }

  useEffect(() => {
    let alive = true;
    fetch("/api/votes")
      .then(r => (r.ok ? r.json() : {}))
      .then(d => { if (alive) setTallies(d || {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const vote = async (hotelId, choice) => {
    setMine(m => ({ ...m, [hotelId]: m[hotelId] === choice ? undefined : choice }));
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId, voterId: getVoterId(), choice }),
      });
      if (res.ok) {
        const d = await res.json();
        setTallies(t => ({ ...t, [hotelId]: { up: d.up, down: d.down } }));
        setMine(m => ({ ...m, [hotelId]: d.your || undefined }));
      }
    } catch (e) {
      // demo fallback: keep an optimistic local count if the API is unreachable
      setTallies(t => {
        const cur = t[hotelId] || { up: 0, down: 0 };
        const was = mine[hotelId];
        const next = { ...cur };
        if (was === choice) next[choice] = Math.max(0, next[choice] - 1);
        else { if (was) next[was] = Math.max(0, next[was] - 1); next[choice] = (next[choice] || 0) + 1; }
        return { ...t, [hotelId]: next };
      });
    }
  };

  return { tallies, mine, vote };
}

function LikeDislike({ hotelId, tallies, mine, vote, size = "sm", stop = true }) {
  const t = tallies[hotelId] || { up: 0, down: 0 };
  const my = mine[hotelId];
  const pad = size === "lg" ? "8px 14px" : "5px 10px";
  const fs = size === "lg" ? 14 : 12.5;
  const handle = (choice) => (e) => { if (stop) e.stopPropagation(); vote(hotelId, choice); };
  const btn = (active, activeColor) => ({
    display: "inline-flex", alignItems: "center", gap: 6, padding: pad, fontSize: fs,
    fontFamily: "'Roboto', sans-serif", cursor: "pointer", borderRadius: 99,
    border: `1px solid ${active ? activeColor : C.line}`,
    background: active ? activeColor : C.card,
    color: active ? "#fff" : C.inkSoft, fontWeight: active ? 600 : 500,
    transition: "all .12s ease",
  });
  return (
    <div style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
      <button onClick={handle("up")} style={btn(my === "up", C.green)} aria-label="Like this hotel" title="Like this hotel">
        <span>Like this hotel</span>
      </button>
      <button onClick={handle("down")} style={btn(my === "down", C.buoy)} aria-label="Dislike this hotel" title="Dislike this hotel">
        <span>Dislike this hotel</span>
      </button>
    </div>
  );
}

function Tag({ children }) {
  return (
    <span style={{
      fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.04em",
      background: C.sea, color: C.ink, padding: "3px 8px", borderRadius: 4,
    }}>{children}</span>
  );
}

function RatingBar({ label, value }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <span style={{ width: 96, fontSize: 13, color: C.inkSoft }}>{label}</span>
      <div style={{ flex: 1, height: 8, background: C.sea, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ width: `${(value / 5) * 100}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${C.seaDeep}, ${C.buoy})` }} />
      </div>
      <span style={{ width: 28, fontFamily: "'Roboto Mono', monospace", fontSize: 12, color: C.ink }}>{value.toFixed(1)}</span>
    </div>
  );
}

function HeroArt({ gradient, big }) {
  const [a, b, c] = gradient || ["#1d4e5f", "#5f9ea8", "#dce9e6"];
  return (
    <div style={{
      position: "relative", overflow: "hidden",
      height: big ? 220 : 150, borderRadius: big ? "12px 12px 0 0" : "10px 10px 0 0",
      background: `linear-gradient(180deg, ${a} 0%, ${b} 62%, ${c} 100%)`,
    }}>
      <svg viewBox="0 0 400 60" preserveAspectRatio="none" style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: big ? 70 : 48, opacity: 0.85 }}>
        <path d="M0,30 C60,10 120,50 200,30 C280,10 340,50 400,30 L400,60 L0,60 Z" fill={c} />
        <path d="M0,42 C70,28 140,56 210,42 C290,28 350,54 400,42 L400,60 L0,60 Z" fill="#ffffff" opacity="0.55" />
      </svg>
    </div>
  );
}

/* ----------------------- AI summary ----------------------- */

function AiSummary({ listing, reviews }) {
  const [state, setState] = useState("idle");
  const [data, setData] = useState(null);

  // reset when navigating between listings
  useEffect(() => { setState("idle"); setData(null); }, [listing.id]);

  const generate = async () => {
    setState("loading");
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: listing.name, place: listing.place, reviews }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setState("done");
    } catch (e) {
      console.error("AI summary failed:", e);
      setData({
        live: false,
        summary: `Guests rate ${listing.name} highly for its setting and core experience, while some reviews flag value-for-money concerns. Read individual reviews below for the full picture.`,
        pros: ["Location and setting", "Cleanliness", "Core experience"],
        cons: ["Value on extras"],
        bestFor: "Travellers seeking a relaxed stay",
      });
      setState("error");
    }
  };

  return (
    <div style={{ border: `1.5px solid ${C.ink}`, borderRadius: 12, background: C.card, padding: 20, marginBottom: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.buoy, textTransform: "uppercase", marginBottom: 4 }}>
            AI review summary
          </div>
          <div style={{ fontSize: 13, color: C.inkSoft }}>
            Generated by Claude from {reviews.length} guest reviews on this page. AI can make mistakes — the reviews themselves are the source of truth.
          </div>
        </div>
        {state !== "done" && state !== "error" && (
          <button onClick={generate} disabled={state === "loading"} style={{
            background: C.ink, color: C.paper, border: "none", borderRadius: 8,
            padding: "10px 18px", fontFamily: "'Roboto', sans-serif", fontWeight: 600,
            fontSize: 14, cursor: state === "loading" ? "wait" : "pointer",
          }}>
            {state === "loading" ? "Reading reviews…" : "Generate summary"}
          </button>
        )}
      </div>

      {(state === "done" || state === "error") && data && (
        <div style={{ marginTop: 16 }}>
          {data.live === false && (
            <div style={{ fontSize: 12, color: C.buoy, marginBottom: 8, fontFamily: "'Roboto Mono', monospace" }}>
              Live AI is not configured — showing a locally prepared summary.
            </div>
          )}
          <p style={{ fontSize: 15, lineHeight: 1.65, color: C.ink, margin: "0 0 14px" }}>{data.summary}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
            <div>
              <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, color: C.green, letterSpacing: "0.1em", marginBottom: 6 }}>GUESTS PRAISE</div>
              {(data.pros || []).map((p, i) => <div key={i} style={{ fontSize: 13.5, color: C.ink, marginBottom: 4 }}>+ {p}</div>)}
            </div>
            <div>
              <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, color: C.buoy, letterSpacing: "0.1em", marginBottom: 6 }}>GUESTS FLAG</div>
              {(data.cons || []).map((p, i) => <div key={i} style={{ fontSize: 13.5, color: C.ink, marginBottom: 4 }}>− {p}</div>)}
            </div>
            <div>
              <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, color: C.inkSoft, letterSpacing: "0.1em", marginBottom: 6 }}>BEST FOR</div>
              <div style={{ fontSize: 13.5, color: C.ink }}>{data.bestFor}</div>
            </div>
          </div>
          <button onClick={generate} style={{
            marginTop: 14, background: "transparent", color: C.inkSoft, border: `1px solid ${C.line}`,
            borderRadius: 8, padding: "6px 12px", fontSize: 12.5, cursor: "pointer",
          }}>Regenerate</button>
        </div>
      )}
    </div>
  );
}

/* ----------------------- review card & form ----------------------- */

function ReviewCard({ r }) {
  const [expanded, setExpanded] = useState(false);
  const long = r.text.length > 320;
  const isAI = r.source === "ai";
  return (
    <div style={{
      background: C.card, borderRadius: 12, padding: 20, marginBottom: 14,
      border: isAI ? `1.5px solid ${C.buoyDim}` : `1px solid ${C.line}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{
            width: 40, height: 40, borderRadius: "50%",
            background: isAI ? C.buoy : C.sea, color: isAI ? "#fff" : C.ink,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: isAI ? 18 : 16,
          }}>{isAI ? "AI" : r.author[0]}</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14.5, color: C.ink }}>
              {r.author}{" "}
              {isAI ? (
                <span style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 10, color: C.buoy, border: `1px solid ${C.buoy}`, borderRadius: 4, padding: "1px 5px", marginLeft: 6 }}>
                  AI summary
                </span>
              ) : r.verified && (
                <span style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 10, color: C.green, border: `1px solid ${C.green}`, borderRadius: 4, padding: "1px 5px", marginLeft: 6 }}>
                  Traveller review
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: C.inkSoft }}>{r.from} · {r.tripType} · {r.month}</div>
          </div>
        </div>
        {!isAI && <Buoys value={r.rating} size={13} />}
      </div>
      <h4 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 17.5, margin: "12px 0 6px", color: C.ink }}>{r.title}</h4>
      <p style={{ fontSize: 14.5, lineHeight: 1.65, color: C.inkSoft, margin: 0 }}>
        {long && !expanded ? r.text.slice(0, 320) + "…" : r.text}
      </p>
      <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "center" }}>
        {long && (
          <button onClick={() => setExpanded(!expanded)} style={{ background: "none", border: "none", color: C.buoy, fontWeight: 600, fontSize: 13, cursor: "pointer", padding: 0 }}>
            {expanded ? "Show less" : "Read full review"}
          </button>
        )}
        <span style={{ fontSize: 12.5, color: C.inkSoft }}>{r.helpful} found this helpful</span>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", marginBottom: 10, padding: "10px 12px",
  border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 14, fontFamily: "'Roboto', sans-serif",
  background: C.paper, color: C.ink, outline: "none",
};

function WriteReview({ onSubmit }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [tripType, setTripType] = useState("Couple");

  const submit = () => {
    if (!rating || !title.trim() || !text.trim()) return;
    onSubmit({
      id: Date.now(), author: author.trim() || "Anonymous traveller", from: "—",
      rating, month: "June 2026", tripType, title: title.trim(), text: text.trim(),
      helpful: 0, verified: false,
    });
    setOpen(false); setRating(0); setTitle(""); setText(""); setAuthor("");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        background: C.buoy, color: "#fff", border: "none", borderRadius: 8,
        padding: "11px 20px", fontWeight: 700, fontSize: 14.5, cursor: "pointer", marginBottom: 20,
      }}>Write a review</button>
    );
  }
  return (
    <div style={{ background: C.card, border: `1.5px solid ${C.buoy}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 12, color: C.ink }}>Share your experience</div>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13.5, color: C.inkSoft }}>Your rating:</span>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} onClick={() => setRating(n)} style={{
            width: 26, height: 26, borderRadius: "50%", cursor: "pointer",
            border: `4px solid ${n <= rating ? C.buoy : C.buoyDim}`, background: "transparent",
          }} aria-label={`${n} of 5`} />
        ))}
      </div>
      <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Your name (optional)" style={inputStyle} />
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Review title" style={inputStyle} />
      <textarea value={text} onChange={e => setText(e.target.value)} rows={4}
        placeholder="Tell other travellers what you genuinely experienced — the good and the bad."
        style={{ ...inputStyle, resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {["Couple", "Family", "Friends", "Solo", "Business"].map(t => (
          <button key={t} onClick={() => setTripType(t)} style={{
            padding: "5px 12px", borderRadius: 99, fontSize: 12.5, cursor: "pointer",
            border: `1px solid ${tripType === t ? C.ink : C.line}`,
            background: tripType === t ? C.ink : "transparent",
            color: tripType === t ? C.paper : C.inkSoft,
          }}>{t}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={submit} style={{ background: C.ink, color: C.paper, border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
          Publish review
        </button>
        <button onClick={() => setOpen(false)} style={{ background: "transparent", color: C.inkSoft, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 18px", fontSize: 14, cursor: "pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ----------------------- detail page ----------------------- */

function DetailPage({ listing, onBack, votes, favs }) {
  const [reviews, setReviews] = useState(SEED_REVIEWS[listing.id] || []);
  const [sort, setSort] = useState("recent");
  const [filter, setFilter] = useState(0);

  useEffect(() => {
    setSort("recent"); setFilter(0);
    setReviews(SEED_REVIEWS[listing.id] || []);
    let alive = true;
    fetchJson(`/api/hotels/${encodeURIComponent(listing.id)}/reviews`)
      .then(rs => { if (alive && Array.isArray(rs)) setReviews(rs); })
      .catch(() => { /* keep seed fallback */ });
    return () => { alive = false; };
  }, [listing.id]);

  const visible = useMemo(() => {
    let r = [...reviews];
    if (filter) r = r.filter(x => x.rating === filter);
    if (sort === "high") r.sort((a, b) => b.rating - a.rating);
    if (sort === "low") r.sort((a, b) => a.rating - b.rating);
    if (sort === "helpful") r.sort((a, b) => b.helpful - a.helpful);
    return r;
  }, [reviews, sort, filter]);

  const dist = [5, 4, 3, 2, 1].map(n => ({ n, count: reviews.filter(r => r.rating === n).length }));
  const maxCount = Math.max(...dist.map(d => d.count), 1);


  return (
    <div>
      <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.line}`, color: C.ink, fontWeight: 700, fontSize: 15, cursor: "pointer", padding: "10px 18px", borderRadius: 99, marginBottom: 16 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        Back
      </button>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
        {listing.city
          ? <CityArt gradient={listing.gradient} image={listing.image} big flat />
          : <HeroArt gradient={listing.gradient} big />}
        <div style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 6 }}>
            {listing.type} · {listing.rank}
          </div>
          <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 34, fontWeight: 700, margin: "0 0 6px", color: C.ink, lineHeight: 1.1 }}>
            {listing.name}
          </h1>
          <div style={{ fontSize: 14.5, color: C.inkSoft, marginBottom: 12 }}>{listing.place} · {listing.price}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 700, color: C.ink }}>{listing.rating.toFixed(1)}</span>
            <Buoys value={listing.rating} size={16} />
            <span style={{ fontSize: 14, color: C.inkSoft }}>{listing.reviewCount} traveller reviews</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {listing.tags.map(t => <Tag key={t}>{t}</Tag>)}
          </div>
          <p style={{ fontSize: 15, lineHeight: 1.7, color: C.inkSoft, margin: "0 0 18px", maxWidth: 720 }}>{listing.about}</p>
          {votes && (
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Would you stay here?</span>
              <LikeDislike hotelId={listing.id} {...votes} size="lg" stop={false} />
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, marginBottom: 28 }}>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 14, color: C.ink }}>Rating breakdown</div>
          {Object.entries(listing.subRatings).map(([k, v]) => <RatingBar key={k} label={k} value={v} />)}
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, marginBottom: 14, color: C.ink }}>Amenities</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 14px" }}>
            {listing.amenities.map(a => <div key={a} style={{ fontSize: 13.5, color: C.inkSoft }}>· {a}</div>)}
          </div>
        </div>
      </div>

      <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 700, color: C.ink, margin: "0 0 6px" }}>
        Traveller reviews
      </h2>
      <p style={{ fontSize: 13.5, color: C.inkSoft, margin: "0 0 18px" }}>
        Written by real guests in their own words. Reviews on this page are demo samples; we never let businesses edit or remove them.
      </p>

      <AiSummary listing={listing} reviews={reviews} />

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 20 }}>
        <div style={{ minWidth: 220, flex: "0 0 auto" }}>
          {dist.map(d => (
            <button key={d.n} onClick={() => setFilter(filter === d.n ? 0 : d.n)} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%", marginBottom: 6,
              background: filter === d.n ? C.sea : "transparent", border: "none",
              borderRadius: 6, padding: "4px 6px", cursor: "pointer",
            }}>
              <span style={{ fontSize: 12.5, color: C.inkSoft, width: 12 }}>{d.n}</span>
              <div style={{ flex: 1, height: 7, background: C.sea, borderRadius: 99, overflow: "hidden" }}>
                <div style={{ width: `${(d.count / maxCount) * 100}%`, height: "100%", background: C.buoy, borderRadius: 99 }} />
              </div>
              <span style={{ fontSize: 12, color: C.inkSoft, width: 16, textAlign: "right" }}>{d.count}</span>
            </button>
          ))}
          {filter !== 0 && <div style={{ fontSize: 11.5, color: C.buoy, fontFamily: "'Roboto Mono', monospace" }}>filtering: {filter}-ring reviews · click again to clear</div>}
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            {[["recent", "Most recent"], ["helpful", "Most helpful"], ["high", "Highest"], ["low", "Lowest"]].map(([k, lbl]) => (
              <button key={k} onClick={() => setSort(k)} style={{
                padding: "6px 13px", borderRadius: 99, fontSize: 13, cursor: "pointer",
                border: `1px solid ${sort === k ? C.ink : C.line}`,
                background: sort === k ? C.ink : C.card,
                color: sort === k ? C.paper : C.inkSoft, fontWeight: sort === k ? 600 : 400,
              }}>{lbl}</button>
            ))}
          </div>
          <WriteReview onSubmit={r => setReviews(prev => [r, ...prev])} />
          {visible.map(r => <ReviewCard key={r.id} r={r} />)}
          {visible.length === 0 && (
            <div style={{ padding: 28, textAlign: "center", color: C.inkSoft, fontSize: 14, background: C.card, border: `1px dashed ${C.line}`, borderRadius: 12 }}>
              No reviews match this filter yet. Clear the filter or be the first to write one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------- explore page ----------------------- */

function ListingCard({ l, onOpen, votes }) {
  return (
    <div onClick={onOpen} style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden",
      cursor: "pointer", transition: "transform .15s ease, box-shadow .15s ease",
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = "0 10px 26px rgba(18,43,51,0.12)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
      <div style={{ position: "relative" }}>
        <CityArt gradient={l.gradient} image={l.image} />
        {l.tc && (
          <span style={{
            position: "absolute", top: 10, left: 10, background: C.buoy, color: "#fff",
            fontFamily: "'Roboto Mono', monospace", fontSize: 10, fontWeight: 500,
            padding: "3px 7px", borderRadius: 4, letterSpacing: "0.04em",
          }}>2026 WINNER</span>
        )}
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 10.5, letterSpacing: "0.12em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 5 }}>
          Hotel · {l.cityName}
        </div>
        <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 600, color: C.ink, marginBottom: 3 }}>{l.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Buoys value={l.rating} size={12} />
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{l.rating.toFixed(1)}</span>
          <span style={{ fontSize: 12.5, color: C.inkSoft }}>({(l.reviewCount || 0).toLocaleString()})</span>
        </div>
        <div style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 12 }}>{l.price}</div>
        {votes && (
          <div onClick={e => e.stopPropagation()}>
            <LikeDislike hotelId={l.id} {...votes} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------- city hero art ----------------------- */

function CityArt({ gradient, big, flat, image }) {
  const [a, b, c] = gradient || ["#1d3a5f", "#4a7ba6", "#dce7f0"];
  const [broken, setBroken] = useState(false);
  const showImg = image && !broken;
  return (
    <div style={{
      position: "relative", overflow: "hidden",
      height: big ? 200 : 128,
      borderRadius: flat ? 0 : (big ? 14 : "10px 10px 0 0"),
      background: `linear-gradient(150deg, ${a} 0%, ${b} 58%, ${c} 100%)`,
    }}>
      {showImg ? (
        <img src={image} alt="" loading="lazy" onError={() => setBroken(true)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <svg viewBox="0 0 400 80" preserveAspectRatio="none" style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: big ? 80 : 54, opacity: 0.5 }}>
          <path d="M0,80 L0,50 L20,50 L20,34 L38,34 L38,50 L60,50 L60,22 L74,22 L74,50 L96,50 L96,40 L120,40 L120,18 L134,18 L134,40 L160,40 L160,52 L188,52 L188,30 L206,30 L206,52 L236,52 L236,38 L262,38 L262,20 L276,20 L276,38 L300,38 L300,50 L324,50 L324,28 L340,28 L340,50 L364,50 L364,42 L400,42 L400,80 Z" fill={c} opacity="0.85" />
        </svg>
      )}
    </div>
  );
}

/* City page hero: use the city's representative image if set, else gradient skyline. */
function CityHero({ city, gradient }) {
  return <CityArt gradient={gradient} image={city && city.image} big />;
}

/* Hotel cover image with gradient fallback (used on cards). */
function HotelImage({ hotel, height = 128, flat }) {
  return <CityArt gradient={hotel.gradient} image={hotel.image} flat={flat} />;
}

/* ----------------------- home (city picker) ----------------------- */

function HomePage({ onOpenCity, onOpenListing, votes, favs, cities, hotels }) {
  const countFor = (key) => hotels.filter(l => l.city === key).length;
  // only show cities that actually have hotels
  const shownCities = cities.filter(c => countFor(c.key) > 0);

  return (
    <div>
      <div style={{ textAlign: "center", padding: "38px 16px 30px" }}>
        <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(30px, 5vw, 46px)", fontWeight: 700, color: C.ink, margin: "0 0 18px", lineHeight: 1.15 }}>
          Find your perfect hotel
        </h1>
        {favs && (
          <button onClick={favs.toggleSite} style={{
            display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer",
            fontSize: 14.5, fontWeight: 600, fontFamily: "'Roboto', sans-serif",
            padding: "9px 20px", borderRadius: 99,
            border: `1.5px solid ${favs.siteFav ? C.buoy : C.ink}`,
            background: favs.siteFav ? C.buoy : C.card, color: favs.siteFav ? "#fff" : C.ink,
          }}>
            {favs.siteFav ? "★ Bookmarked" : "★ Bookmark this site"}
          </button>
        )}
      </div>

      <div style={{ margin: "8px 2px 14px" }}>
        <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, margin: 0 }}>
          Choose a destination
        </h2>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 18 }}>
        {shownCities.map(c => (
          <div key={c.key} onClick={() => onOpenCity(c.key)} style={{
            background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden",
            cursor: "pointer", transition: "transform .15s ease, box-shadow .15s ease",
          }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = "0 12px 28px rgba(18,43,51,0.14)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
            <CityArt gradient={c.gradient} image={c.image} />
            <div style={{ padding: "14px 16px 16px" }}>
              <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 21, fontWeight: 700, color: C.ink }}>{c.name}</div>
              <div style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 10 }}>{c.country}</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                <span style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>Explore</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------- city page (hotels in a city) ----------------------- */

function CityPage({ cityKey, onBack, onOpen, votes, favs, cities, hotels: allHotels }) {
  const city = cities.find(c => c.key === cityKey) || { name: cityKey, country: "", gradient: null };
  const [sort, setSort] = useState("best");
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  const hasSeo = (h) => Boolean((h.seo || "").trim());
  // stable pseudo-random key per hotel id (same idea as the server) so ratings
  // look mixed but the order stays stable across pages/re-renders
  const idRand = (id) => {
    let h = 2166136261; const s = String(id);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  };

  const hotels = useMemo(() => {
    let list = allHotels.filter(l => l.city === cityKey);
    // Hotels with an AI review (SEO) always come first; the chosen sort is the tiebreak.
    const seoFirst = (a, b) => (hasSeo(a) ? 0 : 1) - (hasSeo(b) ? 0 : 1);
    if (sort === "best")   // default: mixed ratings (stable random), SEO first
      list = [...list].sort((a, b) => seoFirst(a, b) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || idRand(a.id) - idRand(b.id));
    if (sort === "rating")
      list = [...list].sort((a, b) => seoFirst(a, b) || b.rating - a.rating || b.reviewCount - a.reviewCount);
    if (sort === "reviews")
      list = [...list].sort((a, b) => seoFirst(a, b) || b.reviewCount - a.reviewCount);
    return list;
  }, [cityKey, sort, allHotels]);

  // pagination
  const totalPages = Math.max(1, Math.ceil(hotels.length / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const pageHotels = hotels.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE);

  // reset to page 1 whenever the sort/city changes
  useEffect(() => { setPage(1); }, [cityKey, sort]);
  // scroll to top of list on page change
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [curPage]);

  return (
    <div>
      <button onClick={onBack} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.line}`, color: C.ink, fontWeight: 700, fontSize: 15, cursor: "pointer", padding: "10px 18px", borderRadius: 99, marginBottom: 16 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        All destinations
      </button>

      <div style={{ marginBottom: 22 }}>
        <CityHero city={city} gradient={city.gradient} />
        <div style={{ marginTop: 16 }}>
          <div style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 11, letterSpacing: "0.14em", color: C.inkSoft, textTransform: "uppercase", marginBottom: 4 }}>
            {city.country}
          </div>
          <h1 style={{ fontFamily: "'Poppins', sans-serif", fontSize: "clamp(28px, 4vw, 40px)", fontWeight: 700, color: C.ink, margin: "0 0 12px", lineHeight: 1.08 }}>
            Best hotels in {city.name}
          </h1>
          {favs && (
            <button onClick={favs.toggleSite} style={{
              display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer",
              fontSize: 14, fontWeight: 600, fontFamily: "'Roboto', sans-serif",
              padding: "8px 18px", borderRadius: 99,
              border: `1.5px solid ${favs.siteFav ? C.buoy : C.ink}`,
              background: favs.siteFav ? C.buoy : C.card, color: favs.siteFav ? "#fff" : C.ink,
            }}>
              {favs.siteFav ? "★ Bookmarked" : "★ Bookmark this site"}
            </button>
          )}
        </div>
      </div>

      {/* sort bar */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
        padding: "12px 14px", background: C.card, border: `1px solid ${C.line}`,
        borderRadius: 12, marginBottom: 20,
      }}>
        <span style={{ fontSize: 12.5, color: C.inkSoft, marginRight: 2 }}>Sort:</span>
        {[["best", "Recommended"], ["rating", "Highest rated"], ["reviews", "Most reviewed"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setSort(k)} style={{
            padding: "7px 13px", borderRadius: 99, fontSize: 13, cursor: "pointer",
            border: `1px solid ${sort === k ? C.ink : C.line}`,
            background: sort === k ? C.ink : C.card, color: sort === k ? C.paper : C.inkSoft, fontWeight: sort === k ? 600 : 400,
          }}>{lbl}</button>
        ))}
      </div>

      {/* result count + page indicator */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <span style={{ fontSize: 13, color: C.inkSoft }}>
          {hotels.length > 0
            ? `Showing ${(curPage - 1) * PER_PAGE + 1}–${Math.min(curPage * PER_PAGE, hotels.length)} of ${hotels.length}`
            : "No results"}
        </span>
        <span style={{ fontSize: 13, color: C.inkSoft }}>Page {curPage} / {totalPages}</span>
      </div>

      {/* ranked list — number + card, like TripAdvisor's numbered results */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {pageHotels.map((l, i) => (
          <CityHotelRow key={l.id} l={l} rank={(curPage - 1) * PER_PAGE + i + 1}
            onOpen={() => { Track.click(l.id); onOpen(l); }} votes={votes} favs={favs} />
        ))}
      </div>
      {hotels.length === 0 && (
        <div style={{ textAlign: "center", color: C.inkSoft, padding: 40, fontSize: 14.5 }}>
          No hotels match this filter. Clear the search or turn off the Travellers' Choice filter.
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

  const btn = (active, disabled) => ({
    minWidth: 38, padding: "8px 12px", borderRadius: 8, fontSize: 13.5, cursor: disabled ? "default" : "pointer",
    border: `1px solid ${active ? C.ink : C.line}`, background: active ? C.ink : C.card,
    color: disabled ? C.line : (active ? C.paper : C.ink), fontWeight: active ? 700 : 500,
  });
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 26, flexWrap: "wrap" }}>
      <button disabled={page === 1} onClick={() => page > 1 && onGo(page - 1)} style={btn(false, page === 1)}>Prev</button>
      {nums.map((n, i) => typeof n === "string"
        ? <span key={n + i} style={{ color: C.inkSoft, padding: "0 2px" }}>…</span>
        : <button key={n} onClick={() => onGo(n)} style={btn(n === page, false)}>{n}</button>
      )}
      <button disabled={page === totalPages} onClick={() => page < totalPages && onGo(page + 1)} style={btn(false, page === totalPages)}>Next</button>
    </div>
  );
}

/* a horizontal TripAdvisor-style result row.
   Shows the platform SEO summary if the hotel has one (full text);
   otherwise falls back to the first real guest quote (fetched on demand). */
function CityHotelRow({ l, rank, onOpen, votes, favs }) {
  const rowRef = React.useRef(null);

  // count a "seen" impression once the row actually scrolls into view
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !("IntersectionObserver" in window)) { Track.seen(l.id); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { Track.seen(l.id); io.disconnect(); } });
    }, { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [l.id]);

  const faved = favs && favs.hotelFavs.has(l.id);

  return (
    <div ref={rowRef} onClick={onOpen} style={{
      display: "grid", gridTemplateColumns: "180px 1fr", gap: 0,
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden",
      cursor: "pointer", transition: "box-shadow .15s ease",
    }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 10px 24px rgba(18,43,51,0.10)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
      <div style={{ position: "relative" }}>
        <CityArt gradient={l.gradient} image={l.image} />
        {l.tc && (
          <span style={{
            position: "absolute", top: 10, left: 10, background: C.buoy, color: "#fff",
            fontFamily: "'Roboto Mono', monospace", fontSize: 10, fontWeight: 500,
            padding: "3px 7px", borderRadius: 4, letterSpacing: "0.04em",
          }}>2026 WINNER</span>
        )}
      </div>
      <div style={{ padding: "14px 18px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 18.5, fontWeight: 700, color: C.ink, lineHeight: 1.2, flex: 1 }}>{l.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 2px", flexWrap: "wrap" }}>
          <Buoys value={l.rating} size={12} />
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{l.rating.toFixed(1)}</span>
          <span style={{ fontSize: 12.5, color: C.inkSoft }}>({(l.reviewCount || 0).toLocaleString()})</span>
          <span style={{ fontSize: 12, color: C.inkSoft }}>· {l.price}</span>
        </div>
        <div style={{ fontSize: 11.5, color: C.inkSoft, fontFamily: "'Roboto Mono', monospace", marginBottom: 8 }}>{l.rank}</div>
        {votes && (
          <div style={{ marginTop: 12 }} onClick={e => e.stopPropagation()}>
            <LikeDislike hotelId={l.id} {...votes} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------- app shell ----------------------- */

/* favorites hook: loads this participant's favorites, exposes toggles */
function useFavorites(pid) {
  const [siteFav, setSiteFav] = useState(false);
  const [hotelFavs, setHotelFavs] = useState(() => new Set());

  useEffect(() => {
    if (!pid) return;
    let alive = true;
    fetchJson(`/api/fav?pid=${encodeURIComponent(pid)}`)
      .then(d => { if (alive && d) { setSiteFav(Boolean(d.siteFav)); setHotelFavs(new Set(d.hotels || [])); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [pid]);

  const toggleSite = () => {
    const next = !siteFav; setSiteFav(next);
    postJson("/api/fav/site", { pid, on: next });
  };
  const toggleHotel = (hotelId) => {
    setHotelFavs(prev => {
      const s = new Set(prev); const next = !s.has(hotelId);
      if (next) s.add(hotelId); else s.delete(hotelId);
      postJson("/api/fav/hotel", { pid, hotelId, on: next });
      return s;
    });
  };
  return { siteFav, hotelFavs, toggleSite, toggleHotel };
}

/* opening modal that asks for the participant id */
function ParticipantModal({ onSubmit }) {
  const [val, setVal] = useState("");
  const submit = () => { const v = val.trim(); if (v) onSubmit(v); };
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "rgba(18,43,51,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.card, borderRadius: 16, padding: "30px 28px", maxWidth: 420, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.3)" }}>
        <h2 style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, margin: "0 0 8px" }}>
          Welcome to the study
        </h2>
        <p style={{ fontSize: 14.5, color: C.inkSoft, lineHeight: 1.6, margin: "0 0 18px" }}>
          Please enter your <b>participant ID</b> to begin. Your browsing and actions on this site will be recorded anonymously under this ID for research analysis.
        </p>
        <input autoFocus value={val} onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="e.g. P001"
          style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", fontSize: 15, borderRadius: 10, border: `1.5px solid ${C.line}`, fontFamily: "'Roboto', sans-serif", color: C.ink, outline: "none", marginBottom: 16 }} />
        <button onClick={submit} disabled={!val.trim()} style={{
          width: "100%", padding: "12px", fontSize: 15, fontWeight: 600, borderRadius: 10, border: "none",
          background: val.trim() ? C.ink : C.line, color: "#fff", cursor: val.trim() ? "pointer" : "default",
          fontFamily: "'Roboto', sans-serif",
        }}>Start</button>
      </div>
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

  // if a participant id was already saved, resume tracking on load (no modal)
  useEffect(() => {
    if (pid) Track.start(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live data from the API, falling back to bundled seed data.
  const [cities, setCities] = useState(SEED_CITIES);
  const [hotels, setHotels] = useState(SEED_LISTINGS);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchJson("/api/cities"), fetchJson("/api/hotels")])
      .then(([c, h]) => { if (alive && c?.length && h?.length) { setCities(c); setHotels(h); } })
      .catch(() => { /* keep bundled fallback (e.g. vite dev with no server) */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  // trackpad: swipe right goes back one level (detail -> city -> home)
  useEffect(() => {
    let acc = 0, fired = false;
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scroll -> ignore
      acc += e.deltaX;
      if (acc > 0) acc = 0;                 // only accumulate rightward (negative) motion
      if (acc < -110 && !fired) {
        fired = true;
        setPage(prev => {
          if (prev.name === "detail") {
            return prev.from === "city"
              ? { name: "city", cityKey: prev.cityKey }
              : { name: "home" };
          }
          if (prev.name === "city") return { name: "home" };
          return prev;
        });
        setTimeout(() => { fired = false; acc = 0; }, 600);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  const startSession = (id) => {
    try { localStorage.setItem("fah_pid", id); } catch {}
    setPid(id); Track.start(id);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: "'Roboto', sans-serif", color: C.ink }}>
      {!pid && <ParticipantModal onSubmit={startSession} />}
      <header style={{
        position: "sticky", top: 0, zIndex: 10, background: "rgba(247,249,248,0.92)",
        backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`,
      }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={() => setPage({ name: "home" })} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: 0 }}>
            <span style={{ fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 700, color: C.ink, letterSpacing: "-0.01em" }}>Find a Hotel</span>
          </button>
          <nav style={{ display: "flex", gap: 14, alignItems: "center" }}>
            {pid && (
              <span style={{ fontFamily: "'Roboto Mono', monospace", fontSize: 12, color: C.inkSoft }}>
                ID {pid}
              </span>
            )}
            <button onClick={() => setPage({ name: "home" })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13.5, color: page.name === "home" ? C.ink : C.inkSoft, fontWeight: page.name === "home" ? 600 : 400, fontFamily: "'Roboto', sans-serif" }}>Destinations</button>
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 20px 60px" }}>
        {page.name === "home" && (
          <HomePage
            votes={votes}
            favs={favs}
            cities={cities}
            hotels={hotels}
            onOpenCity={key => setPage({ name: "city", cityKey: key })}
            onOpenListing={l => setPage({ name: "detail", listing: l, from: "home" })}
          />
        )}
        {page.name === "city" && (
          <CityPage
            cityKey={page.cityKey}
            votes={votes}
            favs={favs}
            cities={cities}
            hotels={hotels}
            onBack={() => setPage({ name: "home" })}
            onOpen={l => setPage({ name: "detail", listing: l, from: "city", cityKey: page.cityKey })}
          />
        )}
        {page.name === "detail" && (
          <DetailPage
            listing={page.listing}
            votes={votes}
            favs={favs}
            onBack={() => {
              if (page.from === "city") setPage({ name: "city", cityKey: page.cityKey });
              else setPage({ name: "home" });
            }}
          />
        )}
      </main>

    </div>
  );
}
