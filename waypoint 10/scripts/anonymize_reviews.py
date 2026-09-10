#!/usr/bin/env python3
"""
Anonymize the guest reviews in data/reviews.csv (the converted import file).

- Replaces each reviewer name with a TripAdvisor-style pseudonym ("Emma R")
  that is DETERMINISTIC: the same original name always maps to the same
  pseudonym, so repeat reviewers stay consistent across hotels.
- Clears the avatar column (the site then shows a coloured initial disc),
  because avatar photos can identify people. Keep them with --keep-avatars.
- Location (city-level) and all other fields are left unchanged.

Usage, from the project folder:
    python3 scripts/anonymize_reviews.py            # rewrites data/reviews.csv in place (a .bak backup is kept)
    python3 scripts/anonymize_reviews.py --keep-avatars
    python3 scripts/anonymize_reviews.py --style traveler   # "Traveler_4821" instead of "Emma R"

Afterwards: commit & push — the server re-imports data/reviews.csv automatically
because the file content changed. Review photos are NOT touched; check them
yourself for faces if that matters for your ethics protocol.
"""
import argparse, csv, hashlib, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FIRST = ("Emma Olivia Sophia Isabella Charlotte Amelia Mia Harper Ella Grace Chloe Lily Hannah Zoe Nora Lucy "
         "Alice Ruby Freya Isla Poppy Daisy Evie Rosie Erin Megan Holly Jessica Lauren Abigail Katie Molly "
         "James Oliver William Henry George Jack Thomas Charlie Daniel Matthew David Joseph Samuel Benjamin "
         "Lucas Ethan Alexander Michael Ryan Nathan Adam Luke Owen Aaron Connor Liam Noah Leo Oscar Harry "
         "Marco Luca Giulia Sofia Antoine Camille Louis Chloe Mathis Lea Hugo Manon Pierre Julien Claire "
         "Anna Maria Elena Paolo Andrea Carlos Ana Miguel Lucia Diego Sara Pablo Marta Juan Laura Sean "
         "Aiden Caleb Dylan Evan Gavin Ian Kyle Mason Tyler Wyatt Zachary Brooke Paige Sydney Taylor Morgan").split()

def pseudonym(name: str, style: str) -> str:
    key = name.strip().lower()
    if not key or key == "guest":
        return "Guest"
    h = hashlib.md5(key.encode("utf-8")).digest()
    if style == "traveler":
        return f"Traveler_{int.from_bytes(h[:3], 'big') % 9000 + 1000}"
    first = FIRST[h[0] % len(FIRST)]
    initial = chr(ord("A") + h[1] % 26)
    return f"{first} {initial}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=os.path.join(ROOT, "data", "reviews.csv"))
    ap.add_argument("--style", choices=["name", "traveler"], default="name", help='pseudonym style: "Emma R" (default) or "Traveler_4821"')
    ap.add_argument("--keep-avatars", action="store_true", help="keep the avatar URLs (default: cleared)")
    args = ap.parse_args()

    if not os.path.exists(args.file):
        sys.exit(f"{args.file} not found — run scripts/filter_reviews.py first.")
    shutil.copy(args.file, args.file + ".bak")

    with open(args.file, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows or "author" not in rows[0]:
        sys.exit("Unexpected file format — expected the converted data/reviews.csv with an 'author' column.")

    mapping = {}
    for r in rows:
        orig = r.get("author", "")
        r["author"] = mapping.setdefault(orig.strip().lower(), pseudonym(orig, args.style))
        if not args.keep_avatars:
            r["avatar"] = ""

    fields = list(rows[0].keys())
    with open(args.file, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    print(f"Anonymized {len(rows)} reviews, {len(mapping)} distinct reviewers → {args.file}")
    print(f"Backup of the original: {args.file}.bak (do NOT commit the .bak if it must stay private)")
    sample = list(mapping.items())[:5]
    for k, v in sample:
        print(f"  {k[:24]!r:28s} → {v}")
    if not args.keep_avatars:
        print("Avatars cleared — the site will show coloured initial discs instead.")

if __name__ == "__main__":
    main()
