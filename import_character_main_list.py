#!/usr/bin/env python3
"""
Import character→main list into Supabase (characters, accounts, character_account).

Reads a tab-separated file with columns: Character, Main.
- Each unique Character → one row in characters (char_id = name = character name).
- Each unique Main → one account (account_id = main name, display_name = main).
- Each (Character, Main) → one row in character_account linking that character to that account.

Usage:
  1. Review (default): fetches current state from Supabase and writes what would be added.
     python import_character_main_list.py --list "message (8).txt" [--review-out data/character_main_import_review.json]

  2. Apply: after reviewing, run with --apply to upsert characters, accounts, and character_account.
     python import_character_main_list.py --list "message (8).txt" --apply

Credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY if RLS allows).
  Loaded from environment or .env / web/.env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY also supported for review; service role needed for inserts).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
PAGE_SIZE = 5000


def _load_env_file(path: Path) -> None:
    """Parse KEY=VALUE lines and set os.environ."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip("'\"")
            if k:
                os.environ.setdefault(k, v)
    for vite, plain in (
        ("VITE_SUPABASE_URL", "SUPABASE_URL"),
        ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
    ):
        if not os.environ.get(plain) and os.environ.get(vite):
            os.environ[plain] = os.environ[vite]


def load_dotenv() -> None:
    """Load .env from repo root and web so SUPABASE_* or VITE_* are available."""
    for path in (
        SCRIPT_DIR / ".env",
        SCRIPT_DIR / "web" / ".env",
        SCRIPT_DIR / "web" / ".env.local",
    ):
        if path.exists():
            _load_env_file(path)


def parse_list_file(path: Path) -> list[tuple[str, str]]:
    """Parse tab-separated Character\\tMain file. Returns list of (character, main) trimmed, no header, no empty."""
    pairs: list[tuple[str, str]] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    for i, line in enumerate(lines):
        parts = line.split("\t")
        if i == 0 and len(parts) >= 2 and parts[0].strip().lower() == "character" and parts[1].strip().lower() == "main":
            continue
        if len(parts) < 2:
            continue
        char_name = (parts[0] or "").strip()
        main_name = (parts[1] or "").strip()
        if not char_name or not main_name:
            continue
        pairs.append((char_name, main_name))
    # Dedupe by (char, main) while preserving order
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for c, m in pairs:
        if (c, m) in seen:
            continue
        seen.add((c, m))
        out.append((c, m))
    return out


def fetch_all(client, table: str, select: str = "*") -> list[dict]:
    """Paginate and return all rows from table."""
    out: list[dict] = []
    offset = 0
    while True:
        resp = client.table(table).select(select).range(offset, offset + PAGE_SIZE - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        out.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return out


def _make_review_html(plan: dict) -> str:
    """Build HTML with plan embedded so it works when opened as file:// (no fetch)."""
    json_str = json.dumps(plan)
    json_str = json_str.replace("</", "<\\/")  # avoid </script> in data breaking the page
    return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Character -> Main import review</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 56rem; margin: 1rem auto; padding: 0 1rem; background: #18181b; color: #fafafa; }
    h1 { font-size: 1.25rem; }
    .summary { background: #27272a; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
    .summary p { margin: 0.25rem 0; }
    details { margin: 0.5rem 0; background: #27272a; border-radius: 6px; }
    summary { padding: 0.5rem 0.75rem; cursor: pointer; }
    ul { margin: 0.25rem 0; padding-left: 1.5rem; }
    .mains { margin-top: 1rem; }
    .main-name { font-weight: 600; color: #a78bfa; }
    .hint { font-size: 0.875rem; color: #71717a; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Character -> Main import review</h1>
  <div id="summary" class="summary"></div>
  <div id="mains" class="mains"></div>
  <p class="hint">After reviewing, run: <code>python import_character_main_list.py --list "message (8).txt" --apply</code></p>
  <script>window.REVIEW_DATA = """ + json_str + """;</script>
  <script>
    (function () {
      var data = window.REVIEW_DATA;
      if (!data) { document.body.insertAdjacentHTML('afterbegin', '<p class="error">No data. Re-run the import script to generate this HTML.</p>'); return; }
      var s = data.summary || {};
      document.getElementById('summary').innerHTML =
        '<p><strong>Rows in file (after dedupe):</strong> ' + (s.total_rows_in_file ?? 0) + '</p>' +
        '<p><strong>Unique characters:</strong> ' + (s.unique_characters ?? 0) + ' (new: ' + (s.new_characters_count ?? 0) + ', already in DB: ' + (s.existing_characters_used ?? 0) + ')</p>' +
        '<p><strong>Unique mains (accounts):</strong> ' + (s.unique_mains ?? 0) + ' (new: ' + (s.new_accounts_count ?? 0) + ', existing: ' + (s.existing_accounts_used ?? 0) + ')</p>' +
        '<p><strong>Character->account links to add:</strong> ' + (s.new_links_count ?? 0) + ' (existing skipped: ' + (s.existing_links_skipped ?? 0) + ')</p>';
      // Only show what will be added: group new_links by main (account)
      var newLinks = data.new_links || [];
      var byMain = {};
      newLinks.forEach(function (row) {
        var main = row.account_id;
        var ch = row.char_id;
        if (!main || !ch) return;
        if (!byMain[main]) byMain[main] = [];
        if (byMain[main].indexOf(ch) === -1) byMain[main].push(ch);
      });
      var html = '<h2>New links by main (account)</h2>';
      function escapeHtml(s) { var div = document.createElement('div'); div.textContent = s; return div.innerHTML; }
      Object.entries(byMain).sort(function(a,b) { return a[0].localeCompare(b[0]); }).forEach(function(entry) {
        var main = entry[0], list = entry[1] || [];
        html += '<details><summary class="main-name">' + escapeHtml(main) + ' <span style="color:#71717a;font-weight:normal">(' + list.length + ')</span></summary><ul>' +
          list.map(function(c) { return '<li>' + escapeHtml(c) + '</li>'; }).join('') + '</ul></details>';
      });
      document.getElementById('mains').innerHTML = html;
    })();
  </script>
</body>
</html>"""


def _in_chars(s: str, existing: set[str]) -> bool:
    return bool(s and (s in existing or s.lower() in existing))


def build_plan(pairs: list[tuple[str, str]], existing_chars: set[str], existing_accounts: set[str], existing_links: set[tuple[str, str]]) -> dict:
    """Compute what to add: new characters, new accounts, new character_account links.
    existing_links uses normalized (lowercase) pairs for case-insensitive match.
    """
    all_chars = {c for c, _ in pairs}
    all_mains = {m for _, m in pairs}
    new_chars = sorted(c for c in all_chars if not _in_chars(c, existing_chars))
    new_accounts = sorted(m for m in all_mains if not _in_chars(m, existing_accounts))
    links_to_add = [(c, m) for c, m in pairs if (c.lower(), m.lower()) not in existing_links]
    links_to_add = list(dict.fromkeys(links_to_add))  # preserve order, dedupe

    # Group by main for summary
    by_main: dict[str, list[str]] = {}
    for c, m in pairs:
        if m not in by_main:
            by_main[m] = []
        if c not in by_main[m]:
            by_main[m].append(c)

    return {
        "summary": {
            "total_rows_in_file": len(pairs),
            "unique_characters": len(all_chars),
            "unique_mains": len(all_mains),
            "new_characters_count": len(new_chars),
            "new_accounts_count": len(new_accounts),
            "new_links_count": len(links_to_add),
            "existing_characters_used": sum(1 for c in all_chars if _in_chars(c, existing_chars)),
            "existing_accounts_used": sum(1 for m in all_mains if _in_chars(m, existing_accounts)),
            "existing_links_skipped": len([1 for c, m in pairs if (c.lower(), m.lower()) in existing_links]),
        },
        "new_characters": new_chars,
        "new_accounts": new_accounts,
        "new_links": [{"char_id": c, "account_id": m} for c, m in links_to_add],
        "by_main": {m: sorted(chars) for m, chars in sorted(by_main.items())},
    }


def main() -> int:
    load_dotenv()

    ap = argparse.ArgumentParser(description="Import character→main list into Supabase (review or apply).")
    ap.add_argument("--list", type=Path, default=SCRIPT_DIR / "message (8).txt", help="Tab-separated file: Character, Main")
    ap.add_argument("--review-out", type=Path, default=DATA_DIR / "character_main_import_review.json", help="Write review JSON here (default: data/character_main_import_review.json)")
    ap.add_argument("--apply", action="store_true", help="Apply changes to Supabase (upsert characters, accounts; insert character_account)")
    args = ap.parse_args()

    if not args.list.exists():
        print(f"List file not found: {args.list}", file=sys.stderr)
        return 1

    pairs = parse_list_file(args.list)
    if not pairs:
        print("No valid Character\\tMain rows found.", file=sys.stderr)
        return 1

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).", file=sys.stderr)
        print("  You can use .env or web/.env with the same variable names.", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)

    print("Fetching existing characters, accounts, character_account from Supabase...", flush=True)
    chars_rows = fetch_all(client, "characters", "char_id,name")
    accounts_rows = fetch_all(client, "accounts", "account_id,display_name")
    ca_rows = fetch_all(client, "character_account", "char_id,account_id")

    # Characters: match list by char_id OR name (DB may use numeric char_id with name = display name)
    existing_chars = set()
    for r in chars_rows:
        cid = (r.get("char_id") or "")
        name = (r.get("name") or "")
        for x in (str(cid).strip(), str(name).strip()):
            if x:
                existing_chars.add(x)
                existing_chars.add(x.lower())

    # Accounts: match list by account_id OR display_name
    existing_accounts = set()
    for r in accounts_rows:
        aid = (r.get("account_id") or "")
        disp = (r.get("display_name") or "")
        for x in (str(aid).strip(), str(disp).strip()):
            if x:
                existing_accounts.add(x)
                existing_accounts.add(x.lower())

    # Links: character_account stores (char_id, account_id). Resolve to (char_name, account_name) so we can
    # match list (Character, Main). Use char_id/name and account_id/display_name, normalized to lowercase.
    char_id_to_keys: dict[str, set[str]] = {}
    for r in chars_rows:
        cid = str(r.get("char_id") or "").strip()
        name = str(r.get("name") or "").strip()
        if cid or name:
            keys = {cid, name, cid.lower(), name.lower()} - {""}
            if cid:
                char_id_to_keys[cid] = char_id_to_keys.get(cid, set()) | keys
            if name and name != cid:
                char_id_to_keys[name] = char_id_to_keys.get(name, set()) | keys
    account_id_to_keys: dict[str, set[str]] = {}
    for r in accounts_rows:
        aid = str(r.get("account_id") or "").strip()
        disp = str(r.get("display_name") or "").strip()
        if aid or disp:
            keys = {aid, disp, aid.lower(), disp.lower()} - {""}
            if aid:
                account_id_to_keys[aid] = account_id_to_keys.get(aid, set()) | keys
            if disp and disp != aid:
                account_id_to_keys[disp] = account_id_to_keys.get(disp, set()) | keys
    existing_links: set[tuple[str, str]] = set()
    for r in ca_rows:
        cid = str(r.get("char_id") or "").strip()
        aid = str(r.get("account_id") or "").strip()
        if not cid or not aid:
            continue
        c_keys = char_id_to_keys.get(cid, {cid, cid.lower()})
        a_keys = account_id_to_keys.get(aid, {aid, aid.lower()})
        for ck in c_keys:
            for ak in a_keys:
                existing_links.add((ck.lower(), ak.lower()))

    plan = build_plan(pairs, existing_chars, existing_accounts, existing_links)

    # For --apply: resolve list (character_name, main_name) to DB (char_id, account_id)
    name_to_char_id: dict[str, str] = {}
    for r in chars_rows:
        cid = str(r.get("char_id") or "").strip()
        name = str(r.get("name") or "").strip()
        if cid:
            name_to_char_id[cid] = cid
            name_to_char_id[cid.lower()] = cid
        if name:
            name_to_char_id[name] = cid or name
            name_to_char_id[name.lower()] = cid or name
    main_to_account_id: dict[str, str] = {}
    for r in accounts_rows:
        aid = str(r.get("account_id") or "").strip()
        disp = str(r.get("display_name") or "").strip()
        if aid:
            main_to_account_id[aid] = aid
            main_to_account_id[aid.lower()] = aid
        if disp:
            main_to_account_id[disp] = aid or disp
            main_to_account_id[disp.lower()] = aid or disp

    # Always write review file and HTML with data inlined (so opening file:// shows details)
    args.review_out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.review_out, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=2)
    print(f"Review written to {args.review_out}", flush=True)

    review_html_path = args.review_out.with_suffix(".html")
    html_body = _make_review_html(plan)
    with open(review_html_path, "w", encoding="utf-8") as f:
        f.write(html_body)
    print(f"Review HTML (with data) written to {review_html_path}", flush=True)

    s = plan["summary"]
    print()
    print("--- Summary ---")
    print(f"  Rows in file (after dedupe): {s['total_rows_in_file']}")
    print(f"  Unique characters: {s['unique_characters']}  (existing in DB: {s['existing_characters_used']}, new: {s['new_characters_count']})")
    print(f"  Unique mains (accounts): {s['unique_mains']}  (existing: {s['existing_accounts_used']}, new: {s['new_accounts_count']})")
    print(f"  Character->account links to add: {s['new_links_count']}  (existing links skipped: {s['existing_links_skipped']})")
    print()

    if not args.apply:
        print("Run with --apply to upsert characters and accounts and insert new character_account links.")
        return 0

    # Apply
    print("Applying changes...", flush=True)

    # 1) Upsert characters (char_id = name = character name)
    new_chars = plan["new_characters"]
    if new_chars:
        batch = 500
        for i in range(0, len(new_chars), batch):
            chunk = new_chars[i : i + batch]
            rows = [{"char_id": c, "name": c} for c in chunk]
            resp = client.table("characters").upsert(rows, on_conflict="char_id").execute()
            if getattr(resp, "error", None):
                print(f"  characters upsert error: {resp.error}", file=sys.stderr)
                return 1
        print(f"  Inserted/updated {len(new_chars)} characters.")
    else:
        print("  No new characters to add.")

    # 2) Upsert accounts (account_id = main, display_name = main, toon_names = comma list, toon_count)
    by_main = plan["by_main"]
    new_accounts = plan["new_accounts"]
    if new_accounts:
        rows = []
        for main in new_accounts:
            toons = by_main.get(main, [])
            toon_names = ",".join(toons)
            rows.append({
                "account_id": main,
                "display_name": main,
                "toon_names": toon_names,
                "toon_count": len(toons),
            })
        resp = client.table("accounts").upsert(rows, on_conflict="account_id").execute()
        if getattr(resp, "error", None):
            print(f"  accounts upsert error: {resp.error}", file=sys.stderr)
            return 1
        print(f"  Inserted/updated {len(new_accounts)} accounts.")
    else:
        print("  No new accounts to add.")

    # Update existing accounts' toon_names / toon_count if we're adding links to them (optional; site uses character_account for membership)
    # We don't change existing accounts' toon_names here to avoid overwriting; character_account is the source of truth for "who is on this account".

    # 3) Insert character_account (only new links). Resolve list names to DB char_id/account_id.
    new_links = plan["new_links"]
    if new_links:
        resolved = []
        for row in new_links:
            c, m = row["char_id"], row["account_id"]
            char_id = name_to_char_id.get(c) or name_to_char_id.get(c.lower()) or c
            account_id = main_to_account_id.get(m) or main_to_account_id.get(m.lower()) or m
            resolved.append({"char_id": char_id, "account_id": account_id})
        batch = 500
        for i in range(0, len(resolved), batch):
            chunk = resolved[i : i + batch]
            resp = client.table("character_account").upsert(chunk, on_conflict="char_id,account_id").execute()
            if getattr(resp, "error", None):
                print(f"  character_account upsert error: {resp.error}", file=sys.stderr)
                return 1
        print(f"  Inserted {len(new_links)} character->account links.")
    else:
        print("  No new character_account links to add.")

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
