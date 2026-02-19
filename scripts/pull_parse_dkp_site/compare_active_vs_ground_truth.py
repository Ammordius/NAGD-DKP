#!/usr/bin/env python3
"""
Compare the active-raids DKP list (paste format: Name, Earned, Spent, Balance, ...) to ground_truth.txt.
Reports exact matches and every mismatch (earned, spent, balance).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


# Active list as pasted by user (Name, Earned, Spent, Balance, ...)
ACTIVE_PASTE = """
Inacht	4992	3729	1263	38 / 38	74 / 74
Radda	1845	1635	210	0 / 38	0 / 74
Rimidal	4595	4398	197	21 / 38	26 / 74
Crushzilla	4097	3917	180	38 / 38	74 / 74
Fayze	2371	2192	179	25 / 38	35 / 74
Akbar	944	812	132	38 / 38	74 / 74
Bhodi	2807	2682	125	38 / 38	74 / 74
Uberest	623	501	122	38 / 38	72 / 74
Zender	2358	2244	114	13 / 38	32 / 74
Rgrok	219	108	111	38 / 38	73 / 74
Shoosh	1976	1873	103	0 / 38	0 / 74
Lamia	3014	2917	97	13 / 38	13 / 74
Zentile	1643	1550	93	6 / 38	16 / 74
Shortok	613	524	89	3 / 38	5 / 74
Monara	956	881	75	38 / 38	64 / 74
Rembylynn	606	532	74	38 / 38	71 / 74
Debrie	655	582	73	38 / 38	72 / 74
Dopp	748	684	64	31 / 38	47 / 74
Jarisy	2137	2078	59	38 / 38	72 / 74
Pursuit	772	715	57	27 / 38	49 / 74
Pugnacious	737	682	55	38 / 38	74 / 74
Savok	3604	3551	53	0 / 38	3 / 74
Minpal	1036	986	50	30 / 38	55 / 74
Elrontaur	381	331	50	9 / 38	25 / 74
Serro	2224	2175	49	30 / 38	56 / 74
Kovah	272	227	45	11 / 38	21 / 74
Meww	1007	963	44	8 / 38	19 / 74
Adilene	205	162	43	26 / 38	43 / 74
Thornwood	148	106	42	0 / 38	11 / 74
Captainhash	51	10	41	0 / 38	4 / 74
Barndog	630	589	41	38 / 38	64 / 74
Cavalier	1536	1497	39	10 / 38	15 / 74
Wildcaller	46	9	37	0 / 38	10 / 74
Sverder	83	47	36	9 / 38	15 / 74
Aldiss	588	552	36	38 / 38	74 / 74
Ammordius	820	787	33	38 / 38	68 / 74
Slay	2631	2599	32	24 / 38	37 / 74
Walex	3213	3182	31	0 / 38	0 / 74
Bopp	554	523	31	38 / 38	66 / 74
Fireblade	173	143	30	23 / 38	27 / 74
Headcrushar	209	179	30	27 / 38	55 / 74
Tuluvien	675	646	29	38 / 38	64 / 74
Xaiterlyn	1040	1013	27	0 / 38	4 / 74
Tesadar	118	93	25	0 / 38	0 / 74
Zaltak	444	419	25	38 / 38	74 / 74
Warboss	1315	1291	24	3 / 38	8 / 74
Hamorf	216	192	24	11 / 38	14 / 74
Tudogs	265	242	23	3 / 38	23 / 74
Zelus	40	19	21	2 / 38	5 / 74
Bizo	572	553	19	9 / 38	12 / 74
Skaruga	353	334	19	0 / 38	6 / 74
Pigpen	288	271	17	17 / 38	35 / 74
Threllin	128	111	17	29 / 38	53 / 74
Beanwolf	319	304	15	28 / 38	52 / 74
Meriadoc	88	74	14	3 / 38	3 / 74
Culkasi	696	683	13	3 / 38	3 / 74
Rangerwoodelf	549	538	11	38 / 38	74 / 74
Noze	11	0	11	6 / 38	6 / 74
Stickie	11	0	11	11 / 38	11 / 74
Xcivi	82	72	10	0 / 38	4 / 74
Darco	10	0	10	10 / 38	10 / 74
Tolsarian	71	62	9	15 / 38	35 / 74
Silent	549	540	9	26 / 38	57 / 74
Tyrreni	52	43	9	0 / 38	4 / 74
Jisu	8	0	8	0 / 38	0 / 74
Jyslia	1448	1442	6	36 / 38	72 / 74
Yuukii	269	264	5	36 / 38	68 / 74
Clegane	137	135	2	12 / 38	28 / 74
"""


def parse_active(s: str) -> list[tuple[str, int, int, int]]:
    """Return list of (name, earned, spent, balance)."""
    rows = []
    for line in s.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        name = (parts[0] or "").strip()
        try:
            earned = int(parts[1].replace(",", ""))
            spent = int(parts[2].replace(",", ""))
            balance = int(parts[3].replace(",", ""))
        except (ValueError, IndexError):
            continue
        rows.append((name, earned, spent, balance))
    return rows


def parse_ground_truth(path: Path) -> list[tuple[str, int, int, int]]:
    """Return list of (name_normalized, earned, spent, balance)."""
    text = path.read_text(encoding="utf-8")
    rows = []
    for line in text.splitlines():
        line = line.rstrip()
        if not line or "\t" not in line:
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        if re.match(r"^\d+/\d+", (parts[1] or "").strip()):
            continue
        name_raw = (parts[1] or "").strip()
        if not name_raw:
            continue
        name = re.sub(r"\s*\[\+\]\s*$", "", name_raw).strip()
        try:
            earned = int(float((parts[5] or "0").replace(",", "")))
            spent = int((parts[6] or "0").replace(",", ""))
            balance = int(float((parts[7] or "0").replace(",", ""))) if len(parts) > 7 else earned - spent
        except (ValueError, IndexError):
            continue
        rows.append((name, earned, spent, balance))
    return rows


def main() -> None:
    gt_path = Path("ground_truth.txt")
    if not gt_path.exists():
        print(f"Missing {gt_path}", file=sys.stderr)
        sys.exit(2)

    active = parse_active(ACTIVE_PASTE)
    gt_list = parse_ground_truth(gt_path)
    gt_by_name = {name.strip().lower(): (name, e, s, b) for name, e, s, b in gt_list}

    print("=" * 90)
    print("ACTIVE RAIDS DKP vs GROUND TRUTH — number-by-number comparison")
    print("=" * 90)
    print(f"\nActive list: {len(active)} rows. Ground truth: {len(gt_list)} rows.\n")

    matches = 0
    mismatches = []

    for a_name, a_earned, a_spent, a_balance in active:
        key = a_name.strip().lower()
        if key not in gt_by_name:
            mismatches.append((a_name, "NOT IN GROUND TRUTH", a_earned, a_spent, a_balance, None, None, None))
            continue
        _, g_earned, g_spent, g_balance = gt_by_name[key]
        if (a_earned, a_spent, a_balance) == (g_earned, g_spent, g_balance):
            matches += 1
            continue
        mismatches.append((a_name, "MISMATCH", a_earned, a_spent, a_balance, g_earned, g_spent, g_balance))

    # Report matches
    print(f"MATCH (100%): {matches} characters — Earned, Spent, Balance all equal to ground truth.\n")

    # Report mismatches
    if not mismatches:
        print("No mismatches. Active list matches ground truth 100%.")
        return

    print("MISMATCHES (Active vs Ground Truth):")
    print("-" * 90)
    print(f"{'Name':<18} {'Source':<8} {'Earned':>8} {'Spent':>6} {'Balance':>7}  |  {'GT Earned':>8} {'GT Spent':>6} {'GT Bal':>7}  |  Deltas")
    print("-" * 90)

    for item in mismatches:
        name, reason, a_e, a_s, a_b, g_e, g_s, g_b = item
        if reason == "NOT IN GROUND TRUTH":
            print(f"{name[:17]:<18} {reason:<8} {a_e:>8} {a_s:>6} {a_b:>7}  |  {'—':>8} {'—':>6} {'—':>7}  |  (not in GT)")
            continue
        de = a_e - g_e if g_e is not None else None
        ds = a_s - g_s if g_s is not None else None
        db = a_b - g_b if g_b is not None else None
        delta_str = f"E:{de:+d} S:{ds:+d} B:{db:+d}" if de is not None else ""
        print(f"{name[:17]:<18} {'MISMATCH':<8} {a_e:>8} {a_s:>6} {a_b:>7}  |  {g_e:>8} {g_s:>6} {g_b:>7}  |  {delta_str}")

    print("-" * 90)
    print(f"\nSummary: {matches} match, {len(mismatches)} do not match 100%.")
    print("\nInterpretation:")
    print("  - If Active shows HIGHER earned/balance than GT: site may be crediting extra DKP (e.g. one more raid/event).")
    print("  - If Active shows HIGHER spent than GT: site may be counting an extra loot win or wrong cost.")
    print("  - Ground truth is the GamerLaunch export; corrections should align the site/database to GT.")
    return


if __name__ == "__main__":
    main()
