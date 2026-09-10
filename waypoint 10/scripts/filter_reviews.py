#!/usr/bin/env python3
"""
Filter a large crawl of hotel reviews down to the 400 hotels in
data/selected_hotels.csv and write data/reviews.csv in the format the admin
"Import guest reviews" uploader expects.

Usage (run on your own machine, from the project folder):

    python3 scripts/filter_reviews.py /path/to/big_reviews.csv
    python3 scripts/filter_reviews.py /path/to/big_reviews.csv --latest 5 --lang en

Input can be CSV / TSV / JSON Lines / a JSON array. The file is read in
chunks, so a multi-GB file is fine. Columns are auto-detected by name
(Chinese or English); if detection guesses wrong, fill in COLUMNS below.

Output columns:
    hotel_id, author, location, rating, date, date_visited, title, text,
    trip_type, helpful, photos (JSON list of {url, caption, photo_id}), language,
    contributions, avatar
hotel_id = TripAdvisor hotel id (the number after "-d" in the hotel URL,
e.g. 210755), which is what the platform uses to match reviews to hotels.
"""
import sys, os, re, json, argparse, csv
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---- Manual override: set any of these to the exact column name in your file
#      if the auto-detection below picks the wrong one (leave "" for auto).
COLUMNS = {
    "hotel_id":   "",   # column with the TripAdvisor hotel id, OR a hotel URL containing -d123456-
    "hotel_name": "",   # used only as a fallback match when no id/url column exists
    "author":     "",
    "rating":     "",
    "date":       "",
    "title":      "",
    "text":       "",
    "trip_type":  "",
}

# candidate names, in priority order, for auto-detection (lower-cased, exact match)
CANDIDATES = {
    "hotel_id":   ["hotel_id", "酒店id", "hotelid", "location_id", "locationid", "id_hotel", "酒店链接", "hotel_url", "location_url", "url", "link", "酒店url"],
    "hotel_name": ["酒店名称", "hotel_name", "location_name", "hotel", "name", "酒店名"],
    "author":     ["reviewer_name", "用户名", "评论用户名", "用户评论用户名", "author", "user", "username", "reviewer", "user_name", "评论者", "reviewer_username"],
    "location":   ["reviewer_location", "user_location", "location", "来自"],
    "rating":     ["review_rating", "评分", "评论评分", "rating", "score", "stars", "星级"],
    "date":       ["review_date", "日期", "评论日期", "date", "published_date", "publish_date", "created_date", "时间"],
    "date_visited": ["date_visited", "stay_date", "入住日期"],
    "title":      ["review_title", "标题", "评论标题", "title"],
    "text":       ["review_text", "评论内容", "评论", "内容", "正文", "用户评论摘录", "text", "review", "content", "body", "comment"],
    "trip_type":  ["trip_type", "出行类型", "旅行类型", "triptype", "trip"],
    "helpful":    ["helpful_vote", "helpful", "helpful_votes", "有用数"],
    "photos":     ["picture_list", "photos", "photo_list", "images", "图片", "评论图片"],
    "language":   ["review_language", "language", "lang", "语言"],
    "contributions": ["reviewer_contribution", "contributions", "user_contributions", "贡献数"],
    "avatar":     ["reviewer_avatar", "avatar", "user_avatar", "头像"],
}

def detect(cols):
    lower = {c.lower().strip(): c for c in cols}
    picked = {}
    for key, cands in CANDIDATES.items():
        if COLUMNS.get(key):
            picked[key] = COLUMNS[key]; continue
        for c in cands:
            if c in lower: picked[key] = lower[c]; break
    return picked

ID_RE = re.compile(r"-d(\d+)-")
def hotel_id_from(value):
    v = "" if value is None else str(value).strip()
    if not v or v.lower() == "nan": return ""
    m = ID_RE.search(v)
    if m: return m.group(1)
    m = re.fullmatch(r"\d+(\.0)?", v)
    if m: return v.split(".")[0]
    return ""

def iter_chunks(path, chunksize=200_000):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jsonl", ".ndjson"):
        buf = []
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try: buf.append(json.loads(line))
                except json.JSONDecodeError: continue
                if len(buf) >= chunksize: yield pd.DataFrame(buf); buf = []
        if buf: yield pd.DataFrame(buf)
    elif ext == ".json":
        with open(path, encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k in ("data", "reviews", "items", "results"):
                if isinstance(data.get(k), list): data = data[k]; break
        for i in range(0, len(data), chunksize): yield pd.DataFrame(data[i:i + chunksize])
    else:
        sep = "\t" if ext in (".tsv", ".txt") else ","
        for chunk in pd.read_csv(path, dtype=str, sep=sep, chunksize=chunksize, on_bad_lines="skip", encoding="utf-8", encoding_errors="replace"):
            yield chunk

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="big reviews file (csv / tsv / jsonl / json)")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "reviews.csv"))
    ap.add_argument("--max-per-hotel", type=int, default=0, help="keep at most N reviews per hotel (0 = all)")
    ap.add_argument("--latest", type=int, default=0, help="keep only the N most recent reviews per hotel (sorted by real date)")
    ap.add_argument("--lang", default="", help="keep only this review language, e.g. en (needs a language column)")
    ap.add_argument("--min-chars", type=int, default=20, help="drop reviews shorter than this")
    args = ap.parse_args()

    sel = pd.read_csv(os.path.join(ROOT, "data", "selected_hotels.csv"), dtype=str)
    wanted = {str(x).strip(): n for x, n in zip(sel["酒店ID"], sel["酒店名称"])}
    name_to_id = {str(n).strip().lower(): str(x).strip() for x, n in zip(sel["酒店ID"], sel["酒店名称"])}
    print(f"Target hotels: {len(wanted)}")

    total_rows = kept = 0
    picked = None
    out_frames = []
    for chunk in iter_chunks(args.input):
        if picked is None:
            picked = detect(chunk.columns)
            print("Detected columns:", picked)
            if "text" not in picked: sys.exit("Could not find the review text column — set COLUMNS['text'] at the top of this script.")
            if "hotel_id" not in picked and "hotel_name" not in picked: sys.exit("Could not find a hotel id / url / name column — set COLUMNS['hotel_id'] or COLUMNS['hotel_name'].")
        total_rows += len(chunk)
        df = pd.DataFrame()
        if "hotel_id" in picked:
            df["hotel_id"] = chunk[picked["hotel_id"]].map(hotel_id_from)
        else:
            df["hotel_id"] = ""
        if "hotel_name" in picked:
            fallback = chunk[picked["hotel_name"]].astype(str).str.strip().str.lower().map(name_to_id).fillna("")
            df["hotel_id"] = df["hotel_id"].where(df["hotel_id"] != "", fallback)
        df = df[df["hotel_id"].isin(wanted.keys())]
        if df.empty: continue
        rows = chunk.loc[df.index]
        for k in ("author", "location", "rating", "date", "date_visited", "title", "text", "trip_type", "helpful", "photos", "language", "contributions", "avatar"):
            df[k] = rows[picked[k]].astype(str).str.strip() if k in picked else ""
        df = df.replace({"nan": "", "None": "", "NaN": ""})
        df = df[df["text"].str.len() >= args.min_chars]
        if args.lang and "language" in picked:
            df = df[df["language"].str.lower() == args.lang.lower()]
        out_frames.append(df)
        kept += len(df)
        print(f"  read {total_rows:,} rows, kept {kept:,}", end="\r")
    print()
    if not out_frames: sys.exit("No reviews matched the 400 hotels. Check the hotel id / url column.")

    out = pd.concat(out_frames, ignore_index=True)
    out = out.drop_duplicates(subset=["hotel_id", "author", "text"])
    # normalise rating to 1-5 (accepts "50", "5", "4.5", "5 of 5 bubbles" ...)
    def norm_rating(v):
        m = re.search(r"\d+(\.\d+)?", str(v)); 
        if not m: return ""
        x = float(m.group()); x = x / 10 if x > 5 else x
        return str(int(round(min(5, max(1, x)))))
    out["rating"] = out["rating"].map(norm_rating)
    # real date parsing (handles 9/9/2025, 2025-09-09, "Sep 2025" ...) so "latest" means latest
    out["_dt"] = pd.to_datetime(out["date"], errors="coerce", format="mixed", dayfirst=True)   # tripadvisor.co.uk export: D/M/YYYY
    out = out.sort_values(["hotel_id", "_dt"], ascending=[True, False], na_position="last")
    out["date"] = out["_dt"].dt.strftime("%Y-%m-%d").fillna(out["date"])
    if args.latest > 0:
        out = out.groupby("hotel_id", group_keys=False).head(args.latest)
    if args.max_per_hotel > 0:
        out = out.groupby("hotel_id", group_keys=False).head(args.max_per_hotel)
    # photos: normalise to a JSON list of {url, caption, photo_id}
    def norm_photos(v):
        v = str(v or "").strip()
        if not v or v in ("[]", "0"): return ""
        try:
            arr = json.loads(v)
            if isinstance(arr, list):
                out_ = [{"url": x.get("url", ""), "caption": x.get("caption", ""), "photo_id": str(x.get("photo_id", ""))} if isinstance(x, dict) else {"url": str(x), "caption": "", "photo_id": ""} for x in arr]
                out_ = [x for x in out_ if x["url"].startswith("http")]
                return json.dumps(out_, ensure_ascii=False) if out_ else ""
        except Exception:
            pass
        urls = [u for u in re.split(r"[|,\s]+", v) if u.startswith("http")]
        return json.dumps([{"url": u, "caption": "", "photo_id": ""} for u in urls], ensure_ascii=False) if urls else ""
    out["photos"] = out["photos"].map(norm_photos)
    out["trip_type"] = out["trip_type"].str.upper().map({"FAMILY": "Traveled with family", "COUPLES": "Traveled as a couple", "BUSINESS": "Traveled on business", "FRIENDS": "Traveled with friends", "SOLO": "Traveled solo", "NONE": ""}).fillna(out["trip_type"])
    out["contributions"] = out["contributions"].map(lambda v: str(int(float(v))) if re.fullmatch(r"\d+(\.\d+)?", str(v)) else "")
    out["avatar"] = out["avatar"].map(lambda v: v if str(v).startswith("http") else "")
    out["helpful"] = out["helpful"].map(lambda v: str(int(float(v))) if re.fullmatch(r"-?\d+(\.\d+)?", str(v)) and float(v) > 0 else "")
    out = out[["hotel_id", "author", "location", "rating", "date", "date_visited", "title", "text", "trip_type", "helpful", "photos", "language", "contributions", "avatar"]]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    out.to_csv(args.out, index=False, encoding="utf-8-sig", quoting=csv.QUOTE_ALL)

    per = out.groupby("hotel_id").size()
    missing = [wanted[h] for h in wanted if h not in per.index]
    print(f"Wrote {len(out):,} reviews for {per.size} / {len(wanted)} hotels → {args.out}")
    print(f"Reviews per hotel: min {per.min()}, median {int(per.median())}, max {per.max()}")
    if missing:
        print(f"{len(missing)} hotels have no reviews in the file, e.g.: {missing[:8]}")
    nphotos = out["photos"].map(lambda v: len(json.loads(v)) if v else 0).sum()
    navatars = out["avatar"].replace("", pd.NA).dropna().nunique()
    print(f"Review photos referenced: {nphotos}, distinct avatars: {navatars}  →  run `npm run review-images` to download them")
    print("\nNext: npm run review-images  →  commit & push (data/reviews.csv + public/images/reviews + public/images/avatars).")
    print("The server loads data/reviews.csv automatically on start-up — no admin import step needed.")

if __name__ == "__main__":
    main()
