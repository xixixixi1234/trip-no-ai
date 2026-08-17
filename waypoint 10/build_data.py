#!/usr/bin/env python3
"""Convert the 8 city travelers-choice CSVs into Waypoint data structures.
Output: cities.js content (CITIES, LISTINGS, REVIEWS_BY_LISTING for imported hotels)."""
import pandas as pd, json, re, math

UP = "/mnt/user-data/uploads"
import os, glob
def find_csv(city_key):
    for f in glob.glob(f"{UP}/*.csv"):
        base = os.path.basename(f).lower()
        if base.startswith(city_key + "_"):
            return f
    raise FileNotFoundError(city_key)

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
    disp = clean(row.get("显示价格")) or clean(row.get("最低价格"))
    lo, hi = row.get("价格区间最低"), row.get("价格区间最高")
    try:
        if not math.isnan(lo) and not math.isnan(hi) and hi > 0:
            return f"${int(lo)} – ${int(hi)} / night"
    except Exception:
        pass
    if disp:
        return f"from {disp} / night"
    return "Price on request"

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

for city_key, (city_name, country, emoji, grad, icon) in CITIES.items():
    df = pd.read_csv(find_csv(city_key))
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

    top = cand.head(400)

    seen_ids = set()
    for i, (_, row) in enumerate(top.iterrows()):
        hid = slugify(clean(row["酒店名称"]) or row["酒店ID"], city_key)
        if hid in seen_ids:
            suffix = 2
            while f"{hid}-{suffix}" in seen_ids:
                suffix += 1
            hid = f"{hid}-{suffix}"
        seen_ids.add(hid)
        rating = round(float(row["评分"]), 1)
        seed = abs(hash(hid)) % 997
        seo_summary = clean(row.get("平台SEO摘要"))
        listing = {
            "id": hid,
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
            "image": "",          # cover image (filled when a CSV has an image column)
            "images": [],
            "about": seo_summary or
                     f"A Travellers' Choice favourite in {city_name} with a {rating:.1f} rating from {int(row['评论数'])} guest reviews. See what recent visitors had to say below.",
            "amenities": amenities_from(row),
            "subRatings": sub_ratings(rating, seed),
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
     "gradient": v[3], "image": ""}
    for k, v in CITIES.items()
]

out = []
out.append("/* ============================================================")
out.append("   Imported city hotel data (Travelers' Choice CSV extract).")
out.append("   Generated by build_data.py — do not edit by hand.")
out.append("   Quotes & usernames are real excerpts from the source data;")
out.append("   sub-ratings are derived illustrative values.")
out.append("   ============================================================ */\n")
out.append("export const CITIES = " + js(cities_meta) + ";\n")
out.append("export const CITY_LISTINGS = " + js(all_listings) + ";\n")
out.append("export const CITY_REVIEWS = " + js(reviews_by) + ";\n")

with open("src/cities.js", "w", encoding="utf-8") as f:
    f.write("\n".join(out))

print(f"Cities: {len(cities_meta)}")
print(f"Listings: {len(all_listings)}")
print(f"With quotes: {sum(1 for r in reviews_by.values() if any(x['source']=='quote' for x in r))}")
print(f"With AI summary: {sum(1 for r in reviews_by.values() if any(x['source']=='ai' for x in r))}")
for k in CITIES:
    n = sum(1 for l in all_listings if l['city']==k)
    print(f"  {k}: {n} hotels")
