#!/usr/bin/env python3
"""Convert the curated hotel CSV (data/selected_hotels.csv — 4 cities x 100
hotels, all with an AI/SEO summary, ratings spread evenly from high to low)
into Waypoint seed data: src/cities.js (CITIES, CITY_LISTINGS, CITY_REVIEWS).

Usage:  python3 build_data.py            # reads data/selected_hotels.csv
        python3 build_data.py path/to.csv
"""
import pandas as pd, json, re, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_CSV = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "data", "selected_hotels.csv")

# city key -> (display name, country, emoji, hero gradient, marker icon)
CITIES = {
    "london":      ("London",      "England, UK",  "🇬🇧", ["#1d3a5f", "#4a7ba6", "#dce7f0"], "🎡"),
    "new_york":    ("New York",    "New York, USA","🇺🇸", ["#1a2b3c", "#3f5f7a", "#dce4ea"], "🗽"),
    "paris":       ("Paris",       "France",       "🇫🇷", ["#4a3b5f", "#8a6fa8", "#ece4f0"], "🗼"),
    "rome":        ("Rome",        "Italy",        "🇮🇹", ["#6b3a2f", "#b07a5a", "#f0e4d8"], "🏛"),
}

MONTHS = ["January","February","March","April","May","June","July","August",
          "September","October","November","December"]

def slugify(s, city):
    s = re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")
    return f"{city}-{s}"[:60]

def clean(v):
    if v is None: return ""
    if isinstance(v, float) and math.isnan(v): return ""
    return str(v).strip()

def price_str(row):
    """TripAdvisor-style 'from $X' — lowest available price, else the low end of the range."""
    disp = clean(row.get("显示价格")) or clean(row.get("最低价格"))
    m = re.search(r"[\d,]+", disp)
    if m:
        return f"from ${int(m.group().replace(',', ''))}"
    lo = row.get("价格区间最低")
    try:
        if not math.isnan(lo) and lo > 0:
            return f"from ${int(lo)}"
    except Exception:
        pass
    return ""

def tags_from(row):
    out = []
    for src in [row.get("酒店风格"), row.get("亮点设施")]:
        s = clean(src)
        if s:
            out += [t.strip() for t in s.split("|") if t.strip()]
    # dedupe, keep order, cap 4
    seen, res = set(), []
    for t in out:
        if t.lower() not in seen:
            seen.add(t.lower()); res.append(t)
    return res[:4]

def amenities_from(row):
    s = clean(row.get("亮点设施"))
    style = clean(row.get("酒店风格"))
    items = [t.strip() for t in (s.split("|") if s else []) if t.strip()]
    items += [t.strip() for t in (style.split("|") if style else []) if t.strip()]
    seen, res = set(), []
    for t in items:
        if t.lower() not in seen:
            seen.add(t.lower()); res.append(t)
    return res[:12] or ["Free WiFi", "24-hour reception"]

def rank_desc(row, city_name):
    rd = clean(row.get("排名描述"))
    if rd: return rd
    return f"Traveller favourite in {city_name}"

# Deterministic sub-ratings derived from the overall rating (small varied offsets)
def sub_ratings(rating, seed):
    base = float(rating)
    def clamp(x): return round(max(1.0, min(5.0, x)), 1)
    o = [(seed*7 % 5 - 2)/10, (seed*3 % 5 - 2)/10, (seed*11 % 5 - 2)/10,
         (seed*5 % 5 - 2)/10, (seed*13 % 5 - 2)/10, (seed*17 % 5 - 2)/10]
    return {
        "Location": clamp(base + 0.3 + o[0]),
        "Cleanliness": clamp(base + 0.2 + o[1]),
        "Rooms": clamp(base - 0.1 + o[2]),
        "Sleep quality": clamp(base + o[3]),
        "Service": clamp(base + 0.1 + o[4]),
        "Value": clamp(base - 0.3 + o[5]),
    }

all_listings = []
reviews_by = {}
# City cover image = the 100th hotel of that city in data/selected_hotels.csv
# (CSV row order). Stored as coverHotelId in CITIES; server.js maps it to the
# downloaded local image. Override with COVER_ROW=<n> (1-based).
COVER_ROW = int(os.environ.get("COVER_ROW", "100"))
cover_hotel = {}
image_urls = {}   # hotel id -> original image_url (kept out of the front-end bundle)

ALL = pd.read_csv(SRC_CSV)
if "城市代码" not in ALL.columns:
    raise SystemExit("expected a 城市代码 column (london / new_york / paris / rome) in " + SRC_CSV)

for city_key, (city_name, country, emoji, grad, icon) in CITIES.items():
    df = ALL[ALL["城市代码"] == city_key].copy()
    # numeric coercion
    for c in ["评分", "评论数", "排名", "纬度", "经度", "价格区间最低", "价格区间最高"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    df["_has_quote"] = df["用户评论摘录"].notna().astype(int)
    df["_has_seo"] = df["平台SEO摘要"].notna().astype(int)

    # Collect ALL quote rows per hotel (author + text) before dedup.
    quotes_by_hotel = {}
    for _, qr in df[df["用户评论摘录"].notna()].iterrows():
        hid = qr["酒店ID"]
        quotes_by_hotel.setdefault(hid, [])
        t = clean(qr["用户评论摘录"])
        u = clean(qr["用户评论用户名"])
        if t and t not in [x[0] for x in quotes_by_hotel[hid]]:
            quotes_by_hotel[hid].append((t, u))

    # Canonical row per hotel: prefer a row that has quote + seo, most reviews.
    dfc = df.sort_values(["酒店ID", "_has_quote", "_has_seo", "评论数"],
                         ascending=[True, False, False, False]).drop_duplicates("酒店ID", keep="first")

    # light sanity filter (mixed quality allowed): valid rating + at least 1 review
    cand = dfc[(dfc["评分"] > 0) & (dfc["评论数"] >= 1)].copy()
    cand["_tc"] = (cand["旅行者之选"] == "是").astype(int)
    cand["_nq"] = cand["酒店ID"].map(lambda h: len(quotes_by_hotel.get(h, [])))
    cand["_has_seo_i"] = cand["平台SEO摘要"].notna().astype(int)
    cand["_hasq"] = (cand["_nq"] > 0).astype(int)
    # Prioritise: has AI summary (SEO) → has real quotes → TC winner → rating → review count
    cand = cand.sort_values(["_has_seo_i", "_hasq", "_tc", "评分", "评论数"],
                            ascending=[False, False, False, False, False])

    top = cand

    # source-id of the cover hotel (CSV order, 1-based row COVER_ROW; falls back to last row)
    src_ids = list(dict.fromkeys(df["酒店ID"].tolist()))
    cover_src = src_ids[min(COVER_ROW, len(src_ids)) - 1] if src_ids else None

    seen_ids = set()
    for i, (_, row) in enumerate(top.iterrows()):
        hid = slugify(clean(row["酒店名称"]) or row["酒店ID"], city_key)
        if hid in seen_ids:
            suffix = 2
            while f"{hid}-{suffix}" in seen_ids:
                suffix += 1
            hid = f"{hid}-{suffix}"
        seen_ids.add(hid)
        if cover_src is not None and row["酒店ID"] == cover_src:
            cover_hotel[city_key] = {"id": hid, "name": clean(row["酒店名称"])}
        rating = round(float(row["评分"]), 1)
        seed = sum((i + 1) * ord(ch) for i, ch in enumerate(hid)) % 997   # stable across runs
        # ---- real "About" details from the extended CSV (no derived numbers)
        def numf(v):
            try:
                v = clean(v); return round(float(v), 1) if v else None
            except Exception: return None
        def lst(v): return [t.strip() for t in clean(v).split("|") if t.strip()]
        def lst_comma(v): return [t.strip() for t in clean(v).split(",") if t.strip()]
        real_sub = {k: numf(row.get(c)) for k, c in [("Location", "位置评分"), ("Rooms", "客房评分"), ("Value", "性价比评分"),
                                                    ("Cleanliness", "清洁度评分"), ("Service", "服务评分"), ("Sleep quality", "睡眠质量评分")]}
        real_sub = {k: v for k, v in real_sub.items() if v is not None}
        dist = {k: int(float(clean(row.get(c)).replace(",", "") or 0)) for k, c in [("Excellent", "Excellent数"), ("Good", "Good数"), ("Average", "Average数"), ("Poor", "Poor数"), ("Terrible", "Terrible数")]}
        m = re.match(r"([\d.]+)\s*of\s*5", clean(row.get("酒店星级")))
        stars = float(m.group(1)) if m else None
        details = {
            "label": clean(row.get("评价标签")),                # Excellent / Very Good / Good / Average / Poor
            "distribution": dist if sum(dist.values()) > 0 else {},
            "propertyAmenities": lst(row.get("酒店设施")),
            "roomFeatures": lst(row.get("客房设施")),
            "roomTypes": lst(row.get("房型")),
            "hotelClass": stars if stars and stars > 0 else None,
            "styles": lst_comma(row.get("酒店风格")),
            "languages": lst_comma(row.get("服务语言")),
        }
        seo_summary = clean(row.get("平台SEO摘要"))
        image = clean(row.get("image_url"))
        image = image if image.startswith("http") else ""
        if image: image_urls[hid] = image
        listing = {
            "id": hid,
            "sourceId": str(row["酒店ID"]).strip(),   # TripAdvisor id (the d123456 in the URL) — used to match reviews
            "type": "Hotel",
            "city": city_key,
            "name": clean(row["酒店名称"]),
            "place": f"{clean(row.get('地址')) or city_name}",
            "cityName": city_name,
            "rating": rating,
            "reviewCount": int(row["评论数"]) if not math.isnan(row["评论数"]) else 0,
            "rank": rank_desc(row, city_name),
            "price": price_str(row),
            "tags": tags_from(row),
            "gradient": grad,
            "tc": bool(row["旅行者之选"] == "是"),
            "lat": None if math.isnan(row.get("纬度", float("nan"))) else round(float(row["纬度"]), 6),
            "lng": None if math.isnan(row.get("经度", float("nan"))) else round(float(row["经度"]), 6),
            "seo": seo_summary,   # platform SEO summary (may be empty)
            "image": "",          # image_url is NOT bundled into the browser JS:
            "images": [],         # it goes to data/image_urls.json (server + download script only)
            "about": clean(row.get("酒店描述")),   # official hotel description from the CSV (may be empty)
            "amenities": amenities_from(row),
            "subRatings": real_sub,          # real TripAdvisor sub-ratings (empty if the CSV has none)
            "details": details,
        }
        all_listings.append(listing)

        # Build reviews from ALL real quotes gathered for this hotel.
        revs = []
        hotel_quotes = quotes_by_hotel.get(row["酒店ID"], [])[:6]
        for qi, (qtext, quser) in enumerate(hotel_quotes):
            qseed = (seed + qi * 37) % 997
            revs.append({
                "id": seed * 100 + qi + 1,
                "author": quser or "Verified guest",
                "from": country,
                "rating": min(5, max(3, round(rating) - (qi % 2))),
                "month": f"{MONTHS[qseed % 12]} 2026",
                "tripType": ["Couple", "Family", "Friends", "Solo", "Business"][qseed % 5],
                "title": ["What guests said", "A recent stay", "Traveller review",
                          "In their own words", "From a verified guest", "Guest impressions"][qseed % 6],
                "text": qtext,
                "helpful": 3 + qseed % 30,
                "verified": True,
                "source": "quote",
            })
        seo = clean(row.get("平台SEO摘要"))
        if seo and seo not in [q[0] for q in hotel_quotes]:
            revs.append({
                "id": seed * 10 + 2,
                "author": "Waypoint AI",
                "from": "Platform summary",
                "rating": min(5, round(rating)),
                "month": "AI overview",
                "tripType": "AI summary",
                "title": "AI summary of guest reviews",
                "text": seo,
                "helpful": 0,
                "verified": False,
                "source": "ai",
            })
        reviews_by[hid] = revs

# ---- emit JS ----
def js(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)

cities_meta = [
    {"key": k, "name": v[0], "country": v[1], "emoji": v[2],
     "gradient": v[3], "image": "",
     "coverHotelId": cover_hotel.get(k, {}).get("id", "")}
    for k, v in CITIES.items()
]

out = []
out.append("/* ============================================================")
out.append("   Curated city hotel data: 4 cities x 100 hotels, all with an AI summary,\n   ratings spread evenly from high to low (data/selected_hotels.csv).")
out.append("   Generated by build_data.py — do not edit by hand.")
out.append("   Quotes & usernames are real excerpts from the source data;")
out.append("   sub-ratings are derived illustrative values.")
out.append("   ============================================================ */\n")
out.append("export const CITIES = " + js(cities_meta) + ";\n")
out.append("export const CITY_LISTINGS = " + js(all_listings) + ";\n")
out.append("export const CITY_REVIEWS = " + js(reviews_by) + ";\n")

with open(os.path.join(HERE, "src", "cities.js"), "w", encoding="utf-8") as f:
    f.write("\n".join(out))
with open(os.path.join(HERE, "data", "image_urls.json"), "w", encoding="utf-8") as f:
    json.dump(image_urls, f, ensure_ascii=False, indent=1)
print(f"Image URLs (data/image_urls.json): {len(image_urls)}")

print(f"Cities: {len(cities_meta)}")
print(f"Listings: {len(all_listings)}")
print(f"With quotes: {sum(1 for r in reviews_by.values() if any(x['source']=='quote' for x in r))}")
print(f"With AI summary: {sum(1 for r in reviews_by.values() if any(x['source']=='ai' for x in r))}")
for k in CITIES:
    n = sum(1 for l in all_listings if l['city']==k)
    c = cover_hotel.get(k, {})
    print(f"  {k}: {n} hotels — cover (row {COVER_ROW}): {c.get('name','?')} [{c.get('id','')}]")
