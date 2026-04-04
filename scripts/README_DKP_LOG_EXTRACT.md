# DKP Log Extract (GUI)

Standalone app for someone who has an EQ log but should **not** send the full log. They run the app, open the log file, and save a small **JSON file** that contains only parsed loot (dates, item names, winners, DKP cost). No log text is included.

## Usage (for your friend)

1. Run `DKP_Log_Extract.exe` (or run with Python: `python scripts/dkp_log_extract_gui.py`).
2. Click **Open log file...** and choose their EQ chat log (e.g. `eqlog_Character_loginse.txt`).
3. Check the summary (number of 0 DKP and DKP entries) and the preview.
4. Click **Save output JSON...** and save a file (e.g. `parsed_loot.json`).
5. Send you that JSON file (e.g. email / Discord). You run the rest of the workflow (raid matching, character resolution, upload) on your side.

## Output format

The saved JSON looks like:

```json
{
  "parsed_loot": [
    { "log_date": "2026-02-09", "item_name": "Bracelet of Darkness", "winner_log_name": "Slay", "cost": 0 },
    ...
  ]
}
```

You can merge this into your audit pipeline (e.g. feed into logic that matches `log_date` to raids and `winner_log_name` to characters, then upload).

## Build the executable

From the **dkp** repo root:

```bash
pip install pyinstaller
pyinstaller scripts/DKP_Log_Extract.spec
```

The single-file executable is created at `dist/DKP_Log_Extract.exe`. Give that exe (and this short usage note) to your friend; they do not need Python or the repo.
