#!/usr/bin/env python3
"""Cross-reference message (8).txt (Character\tMain) vs inactive_raiders_to_add.txt and dry run 'match existing account' list."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Parse message (8).txt: Character\tMain
msg = (ROOT / "message (8).txt").read_text(encoding="utf-8")
lines = [l.strip().split("\t") for l in msg.splitlines() if l.strip() and "\t" in l]
if lines and lines[0] == ["Character", "Main"]:
    lines = lines[1:]
main_to_chars: dict[str, list[str]] = {}
for char, main in lines:
    main = main.strip()
    char = char.strip()
    main_to_chars.setdefault(main, []).append(char)
mains = sorted(main_to_chars.keys())

# 226 to add
inactive = set()
for l in (ROOT / "docs" / "inactive_raiders_to_add.txt").read_text(encoding="utf-8").splitlines():
    l = l.strip()
    if l and not l.startswith("#"):
        inactive.add(l)

# 84 that match existing account (from dry run summary section 5)
match_existing = {
    "Abomination", "Advocatus", "Amirite", "Animaul", "Barlu", "Blaline", "Brando", "Breathless",
    "Burgee", "Cassimir", "Christis", "Cogne", "Cutten", "Danzig", "Deathfo", "Demonicadhd", "Dima",
    "Duncann", "Eilfie", "Eliya", "Ellyas", "Emryes", "Enot", "Flawed", "Frinop", "Fungusfeet", "Fuzy",
    "Galdawm", "Gamuk", "Gorren", "Gulo", "Hodoor", "Htaed", "Iddaa", "Jackyydaytona", "Jojobo",
    "Kaielen", "Kandias", "Khord", "Kuroinu", "Ladakh", "Lalisa", "Lanny", "Maclin", "Mandown",
    "Mather", "Mewmew", "Mojochanter", "Moonpie", "Moonshine", "Mudbut", "Muver", "Necromanz",
    "Nizshad", "Nyashem", "Onward", "Palarran", "Palski", "Paolin", "Papertank", "Pretzella",
    "Pryze", "Qazadan", "Quillen", "Roach", "Ruken", "Ryukyu", "Safetouch", "Salan", "Sizlak",
    "Sport", "Steenke", "Surron", "Taker", "Trevelyen", "Vashen", "Verdent", "Verduaga", "Wanor",
    "Yvonne", "Zekkez", "Zetter",
}

in_226_and_match = [m for m in mains if m in inactive and m in match_existing]
in_226_only = [m for m in mains if m in inactive and m not in match_existing]
main_not_in_226 = [m for m in mains if m not in inactive]

out = [
    "# Cross-reference: message (8).txt Mains vs inactive raiders to add",
    "",
    "`message (8).txt` = Character\\tMain (official main list).",
    "`inactive_raiders_to_add.txt` = 226 names that would get a new account if we run apply.",
    "Dry run section 5 = 84 names that already have an existing Supabase account (same name).",
    "",
    "## Abomination (and similar cases)",
    "",
    "**Abomination** is in message (8).txt as a **Main** with characters: Abomination, Dormak, Kinaelyan, Koreksis, Niluvien, Venaelen, Yinikren.",
    "",
    "- Abomination **is** in our 226 list (we would create account `unlinked_Abomination`).",
    "- Abomination **matches an existing Supabase account** (account_id or display_name Abomination already exists).",
    "- So the Abomination **main is already on the site**. The character \"Abomination\" from CSV is not linked to that account (char_id mismatch).",
    "- **Action:** Do **not** create a new account for Abomination. **Link** the character Abomination (its char_id from CSV) to the existing account \"Abomination\" (e.g. via Officer add-character or SQL).",
    "",
    f"## Mains in message (8).txt that are in 226 AND match existing account ({len(in_226_and_match)} — link, do not create new)",
    "",
    "These mains already have an account on the site. Link the character to that account instead of running apply for them:",
    "",
]
for m in in_226_and_match:
    chars = main_to_chars[m][:8]
    suffix = " ..." if len(main_to_chars[m]) > 8 else ""
    out.append(f"- **{m}** (chars in message: {', '.join(chars)}{suffix})")
out.extend([
    "",
    f"## Mains in message (8).txt that are in 226 only ({len(in_226_only)} — will get new account when apply runs)",
    "",
])
for m in in_226_only[:50]:
    out.append(f"- {m}")
if len(in_226_only) > 50:
    out.append(f"- ... and {len(in_226_only) - 50} more")
out.extend([
    "",
    f"## Mains in message (8).txt NOT in our 226 ({len(main_not_in_226)} — already on site with linked chars)",
    "",
])
for m in main_not_in_226[:40]:
    out.append(f"- {m}")
if len(main_not_in_226) > 40:
    out.append(f"- ... and {len(main_not_in_226) - 40} more")

(ROOT / "docs" / "inactive_raiders_crossref_message.md").write_text("\n".join(out), encoding="utf-8")
print("Wrote docs/inactive_raiders_crossref_message.md")
print(f"  in_226_and_match (link to existing): {len(in_226_and_match)}")
print(f"  in_226_only (new account when apply): {len(in_226_only)}")
print(f"  main_not_in_226 (already on site): {len(main_not_in_226)}")
