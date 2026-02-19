#!/usr/bin/env python3
"""
Standalone GUI: open one EQ log file, parse 0 DKP and DKP loot, save a small JSON
with only parsed data (no log content). Your friend sends the JSON; you run the
rest of the workflow (raid/character matching, upload) on your side.

Uses the same parsing as audit_log_zerodkp_rolls.py (OOC / tells lines only).
"""

import json
import re
from pathlib import Path
from tkinter import Tk, ttk, filedialog, messagebox, scrolledtext, StringVar

# ---- Log line format (same as audit script) ----
LOG_LINE_OOC = re.compile(
    r"^\[([^\]]+)\]\s+\w+\s+says\s+out\s+of\s+character\s*,\s*'([^']*)'",
    re.IGNORECASE,
)
LOG_LINE_TELL = re.compile(
    r"^\[([^\]]+)\]\s+(\w+)\s+tells\s+\S+\s*,\s*'([^']*)'",
    re.IGNORECASE,
)
# Non-name words that must never be treated as a winner (parser can capture them from "congrats  congrats slay")
WINNER_BLACKLIST = frozenset({"congrats", "grats", "you"})
LOG_DATE_FMT = "%a %b %d %H:%M:%S %Y"


def parse_log_timestamp(ts_str: str) -> str | None:
    try:
        from datetime import datetime
        dt = datetime.strptime(ts_str.strip(), LOG_DATE_FMT)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return None


def _item_candidates_from_message(msg: str) -> list:
    lower = msg.lower()
    item_candidates = []
    for sep in [" grats ", " congrats ", " no bids", " tie"]:
        idx = lower.find(sep)
        if idx > 0:
            head = msg[:idx].strip()
            if head:
                item_candidates.append(head.strip())
    if not item_candidates and lower.startswith("no bids "):
        first_part = msg.split(",")[0].strip() if "," in msg else msg
        item_candidates.append(re.sub(r"^no\s+bids\s+", "", first_part, flags=re.IGNORECASE).strip())
    if not item_candidates and " no bids" in lower:
        idx = lower.find(" no bids")
        if idx > 0:
            item_candidates.append(msg[:idx].strip())
    if not item_candidates:
        head = msg.split(",")[0].strip() if "," in msg else msg
        if head:
            item_candidates.append(head)
    return item_candidates


def parse_dkp_awards(line_message: str, log_date: str) -> list:
    msg = line_message.strip()
    if not msg:
        return []
    lower = msg.lower()
    if "grats" not in lower and "congrats" not in lower:
        return []
    dkp_match = re.search(r"(\d+)\s*dkp", lower)
    if not dkp_match or int(dkp_match.group(1)) == 0:
        return []
    item_candidates = _item_candidates_from_message(msg)
    results = []
    for m in re.finditer(r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+(\d+)\s*dkp", msg, re.IGNORECASE):
        winner, cost_str = m.group(1).strip(), m.group(2)
        cost = int(cost_str)
        if cost > 0:
            results.append({
                "item_name_placeholder": item_candidates[0] if item_candidates else "",
                "winner_log_name": winner,
                "cost": cost,
                "log_date": log_date,
            })
    if not results:
        for m in re.finditer(r"(\d+)\s*dkp\s*[,!.]?\s*(?:and\s+)?(?:congrats|grats)\s+([A-Za-z0-9]+)", msg, re.IGNORECASE):
            cost, winner = int(m.group(1)), m.group(2).strip()
            if cost > 0:
                results.append({
                    "item_name_placeholder": item_candidates[0] if item_candidates else "",
                    "winner_log_name": winner,
                    "cost": cost,
                    "log_date": log_date,
                })
    if not results:
        single = re.search(r"(\d+)\s*dkp\s*(?:congrats|grats)\s+([A-Za-z0-9]+)", msg, re.IGNORECASE)
        if single:
            cost, winner = int(single.group(1)), single.group(2).strip()
            if cost > 0:
                results.append({
                    "item_name_placeholder": item_candidates[0] if item_candidates else "",
                    "winner_log_name": winner,
                    "cost": cost,
                    "log_date": log_date,
                })
    return results


def parse_zerodkp_roll_awards(line_message: str, log_date: str) -> list:
    msg = line_message.strip()
    if not msg:
        return []
    lower = msg.lower()
    results = []

    if "anyone beat" in lower and "grats" not in lower and "congrats" not in lower:
        return []
    if re.search(r"\d+\s*/\s*\d+\s*(?:raud\s+)?roll\s+on\s+", lower) and "grats" not in lower and "congrats" not in lower:
        return []

    has_zerodkp_indicator = (
        "top roll" in lower or "top rolls" in lower
        or re.search(r"top\s+\d*\s*rolls?", lower)
        or "no bids" in lower
        or ("high roll" in lower and "0 dkp" in lower)
        or ("0 dkp" in lower)
    )
    if not has_zerodkp_indicator:
        dkp_match = re.search(r"(\d+)\s*dkp", lower)
        if dkp_match and int(dkp_match.group(1)) > 0:
            return []
    if "tie" in lower and "grats" not in lower and "congrats" not in lower:
        return []

    item_candidates = _item_candidates_from_message(msg)
    winners = []

    no_bids = re.search(
        r"no\s+bids\s*,\s*([^.!]+?)\s+top\s+rolls?\s*[,!.]",
        msg, re.IGNORECASE | re.DOTALL,
    )
    if no_bids:
        names_part = no_bids.group(1).strip()
        for part in re.split(r"\s+and\s+|\s*,\s*", names_part, flags=re.IGNORECASE):
            w = part.strip()
            if len(w) > 1 and w not in ("no", "bids"):
                winners.append((w, msg))

    if not winners:
        congrats_two = re.search(
            r"(?:congrats|grats)\s+([A-Za-z0-9]+(?:\s+and\s+[A-Za-z0-9]+)?)\s+.*?top\s+rolls?\s*(?:[,!.]|\s|$)",
            msg, re.IGNORECASE | re.DOTALL,
        )
        if congrats_two:
            for name in re.split(r"\s+and\s+", congrats_two.group(1).strip(), flags=re.IGNORECASE):
                w = name.strip()
                if w:
                    winners.append((w, msg))

    if not winners:
        no_bids_item_winner = re.search(
            r"no\s+bids\s+[^,]+,?\s*([A-Za-z0-9]+)\s+top\s+roll", msg, re.IGNORECASE
        )
        if no_bids_item_winner:
            winners.append((no_bids_item_winner.group(1).strip(), msg))

    if not winners:
        no_bids_then_names = re.search(
            r"no\s+bids\s*,\s*([^.?]+?)\s+top\s+\d*\s*rolls?\s*[?!.]?", msg, re.IGNORECASE
        )
        if no_bids_then_names:
            for part in re.split(r"\s+and\s+|\s*,\s*", no_bids_then_names.group(1).strip(), flags=re.IGNORECASE):
                w = part.strip()
                if len(w) > 1 and w not in ("no", "bids"):
                    winners.append((w, msg))

    if not winners:
        for w in re.findall(r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+.*?top\s+roll", msg, re.IGNORECASE | re.DOTALL):
            winners.append((w.strip(), msg))

    high_roll = re.search(
        r"([A-Za-z0-9]+)\s+other\s+with\s+the\s+high\s+roll\s+0\s*dkp", msg, re.IGNORECASE
    )
    if high_roll:
        w = high_roll.group(1).strip()
        if w and (w, msg) not in [(x, _) for x, _ in winners]:
            winners.append((w, msg))

    if not winners:
        top_rolls = re.search(
            r"([A-Za-z0-9]+(?:\s+and\s+[A-Za-z0-9]+)?)\s+top\s+rolls?\s*(?:[,!.]|\s|$)", msg, re.IGNORECASE
        )
        if top_rolls:
            for name in re.split(r"\s+and\s+", top_rolls.group(1).strip(), flags=re.IGNORECASE):
                w = name.strip()
                if w:
                    winners.append((w, msg))

    if not winners:
        grats_with_roll = re.search(
            r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+with\s+a\s+\d+\s+roll", msg, re.IGNORECASE
        )
        if grats_with_roll:
            winners.append((grats_with_roll.group(1).strip(), msg))

    if not winners:
        grats_w_slash = re.search(
            r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+w/\s*\d+", msg, re.IGNORECASE
        )
        if grats_w_slash:
            winners.append((grats_w_slash.group(1).strip(), msg))

    if not winners:
        return []

    item_placeholder = item_candidates[0] if item_candidates else ""
    for win_name, _ in winners:
        results.append({
            "item_name_placeholder": item_placeholder,
            "winner_log_name": win_name,
            "log_date": log_date,
        })
    return results


def scan_log_file(path: Path) -> list:
    """Return list of { log_date, item_name, winner_log_name, cost } — no raw log content."""
    entries = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n\r")
            m = LOG_LINE_TELL.match(line)
            if m:
                ts_str, sender, quoted = m.group(1), m.group(2), m.group(3)
            else:
                m = LOG_LINE_OOC.match(line)
                if not m:
                    continue
                ts_str, quoted = m.group(1), m.group(2)
                sender = None
            log_date = parse_log_timestamp(ts_str)
            if not log_date:
                continue

            def _is_valid_winner(name: str) -> bool:
                if not name:
                    return False
                low = name.strip().lower()
                if low in WINNER_BLACKLIST:
                    return False
                if sender and low == sender.lower():
                    return False
                return True

            for a in parse_zerodkp_roll_awards(quoted, log_date):
                if not _is_valid_winner(a["winner_log_name"]):
                    continue
                item_name = (a.get("item_name_placeholder") or "").strip() or "Unknown"
                entries.append({
                    "log_date": log_date,
                    "item_name": item_name,
                    "winner_log_name": a["winner_log_name"],
                    "cost": 0,
                })
            for a in parse_dkp_awards(quoted, log_date):
                if not _is_valid_winner(a["winner_log_name"]):
                    continue
                item_name = (a.get("item_name_placeholder") or "").strip() or "Unknown"
                entries.append({
                    "log_date": log_date,
                    "item_name": item_name,
                    "winner_log_name": a["winner_log_name"],
                    "cost": a["cost"],
                })
    return entries


class LogExtractApp:
    def __init__(self):
        self.root = Tk()
        self.root.title("DKP Log Extract — send JSON, not the log")
        self.root.geometry("640x480")
        self.root.minsize(400, 300)

        self.log_path = None
        self.parsed = []  # list of { log_date, item_name, winner_log_name, cost }

        top = ttk.Frame(self.root, padding=8)
        top.pack(fill="x")
        ttk.Button(top, text="Open log file...", command=self._open_log).pack(side="left", padx=4)
        self._path_var = StringVar(value="(no file)")
        ttk.Label(top, textvariable=self._path_var).pack(side="left", padx=4)
        ttk.Button(top, text="Save output JSON...", command=self._save_json).pack(side="left", padx=4)

        info = ttk.LabelFrame(self.root, text="What this does", padding=6)
        info.pack(fill="x", padx=8, pady=4)
        ttk.Label(
            info,
            text="Opens one EQ chat log, parses loot lines (OOC / raid tells). Output is a small JSON with dates, items, winners, and DKP cost — no log text. Send that file; you run raid/character matching and upload on your side.",
            wraplength=580,
        ).pack(anchor="w")

        summary = ttk.LabelFrame(self.root, text="Summary", padding=6)
        summary.pack(fill="x", padx=8, pady=4)
        self._summary_var = StringVar(value="Open a log file to see parsed loot count.")
        ttk.Label(summary, textvariable=self._summary_var).pack(anchor="w")

        preview = ttk.LabelFrame(self.root, text="Preview (first 20 entries)", padding=6)
        preview.pack(fill="both", expand=True, padx=8, pady=4)
        self.preview_text = scrolledtext.ScrolledText(preview, height=12, wrap="word", state="disabled")
        self.preview_text.pack(fill="both", expand=True)

    def _open_log(self):
        path = filedialog.askopenfilename(
            title="Select EQ log file",
            filetypes=[("Log files", "*.txt"), ("All files", "*.*")],
        )
        if not path:
            return
        path = Path(path)
        if not path.is_file():
            messagebox.showerror("Error", "File not found.")
            return
        try:
            self.parsed = scan_log_file(path)
            self.log_path = path
            self._path_var.set(path.name)
            n0 = sum(1 for e in self.parsed if e.get("cost") == 0)
            n_dkp = len(self.parsed) - n0
            self._summary_var.set(
                f"Parsed {len(self.parsed)} loot entries ({n0} at 0 DKP, {n_dkp} with DKP). Save output JSON to send."
            )
            self.preview_text.config(state="normal")
            self.preview_text.delete("1.0", "end")
            for e in self.parsed[:20]:
                self.preview_text.insert("end", f"  {e['log_date']}  {e['item_name'][:40]}  → {e['winner_log_name']}  {e['cost']} DKP\n")
            if len(self.parsed) > 20:
                self.preview_text.insert("end", f"  ... and {len(self.parsed) - 20} more.\n")
            self.preview_text.config(state="disabled")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to parse log: {e}")
            self.parsed = []
            self._summary_var.set("Parse failed.")

    def _save_json(self):
        if not self.parsed:
            messagebox.showwarning("Nothing to save", "Open a log file first and parse it.")
            return
        path = filedialog.asksaveasfilename(
            title="Save parsed loot JSON",
            defaultextension=".json",
            filetypes=[("JSON", "*.json"), ("All files", "*.*")],
        )
        if not path:
            return
        out = {"parsed_loot": self.parsed}
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(out, f, indent=2)
            messagebox.showinfo("Saved", f"Saved {len(self.parsed)} entries to:\n{path}")
        except Exception as e:
            messagebox.showerror("Error", f"Could not save: {e}")

    def run(self):
        self.root.mainloop()


def main():
    app = LogExtractApp()
    app.run()


if __name__ == "__main__":
    main()
