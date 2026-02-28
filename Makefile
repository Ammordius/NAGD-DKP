# Local raid pull & upload (no GitHub secrets — use cookies.txt and .env)
#
# Prereqs:
#   - cookies.txt in repo root with your GamerLaunch Cookie header (one line). Never commit it.
#   - .env or web/.env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
#
# On Windows (no make/nmake): use PowerShell script instead:
#   .\raids.ps1 pull-raids              # page 1 only, since today
#   .\raids.ps1 pull-raids-ids 1598692,1598705
#   .\raids.ps1 pull-attendees
#   .\raids.ps1 upload-raids
#   .\raids.ps1 upload-raids-ids 1598692,1598705   # upload only these two
#   .\raids.ps1 sync-raids
#   .\raids.ps1 pull-members-dkp        # download Current Member DKP page
#   .\raids.ps1 audit-dkp               # download + parse + audit vs Supabase
#
# With GNU make (Git Bash / WSL / Linux / macOS):
#   make pull-raids          # page 1 only, raids since today
#   make pull-attendees
#   make upload-raids
#   make upload-raids-ids RAID_IDS=1598692,1598705   # upload only these, skip 1598690
#   make pull-raids-ids RAID_IDS=1598692,1598705
#   make sync-raids
#   make pull-members-dkp    # download members DKP page to data/members_dkp.html
#   make audit-dkp           # pull members + parse + audit vs Supabase (exit 0 = match)

PYTHON := python
SCRIPTS := scripts/pull_parse_dkp_site
COOKIES := cookies.txt
RAIDS_DIR := raids
INDEX := raids_index.csv
# Since-date: read from .raids-since-date (one line YYYY-MM-DD). After pull, script updates it to today. Default 2026-02-27.
SINCE_DATE_FILE := .raids-since-date
DEFAULT_SINCE_DATE := 2026-02-27
LIMIT_PAGES := 1
# Compute since-date: use file if present, else default. (GNU make / Bash.)
SINCE_DATE := $(shell (test -f $(SINCE_DATE_FILE) && cat $(SINCE_DATE_FILE)) || echo "$(DEFAULT_SINCE_DATE)")

.PHONY: pull-raids pull-raids-ids pull-attendees upload-raids upload-raids-ids upload-raid-detail sync-raids check-cookie pull-members-dkp audit-dkp pull-members-dkp audit-dkp

check-cookie:
	@$(PYTHON) -c "from pathlib import Path; p=Path('$(COOKIES)'); exit(0 if p.exists() else (print('Create $(COOKIES) with your GamerLaunch Cookie header (one line). Do not commit.'), 1)[1])"

# Pull raid list (since date in .raids-since-date) + each raid detail page. Updates .raids-since-date to today after pull.
pull-raids: check-cookie
	@echo "Pulling raids since $$(cat $(SINCE_DATE_FILE) 2>/dev/null || echo '$(DEFAULT_SINCE_DATE)') (page 1 only)..."
	$(PYTHON) $(SCRIPTS)/pull_raids.py \
	  --since-date $(SINCE_DATE) \
	  --limit-pages $(LIMIT_PAGES) \
	  --cookies-file $(COOKIES) \
	  --out-dir $(RAIDS_DIR) \
	  --index $(INDEX) \
	  --sleep 2 --jitter 0.5
	@echo "$$(date +%Y-%m-%d 2>/dev/null || echo '2026-02-27')" > $(SINCE_DATE_FILE)

# Pull only specific raid IDs (e.g. make pull-raids-ids RAID_IDS=1598692,1598705).
pull-raids-ids: check-cookie
	@test -n "$(RAID_IDS)" || (echo "Usage: make pull-raids-ids RAID_IDS=1598692,1598705"; exit 1)
	$(PYTHON) $(SCRIPTS)/pull_raids.py \
	  --raid-ids "$(RAID_IDS)" \
	  --cookies-file $(COOKIES) \
	  --out-dir $(RAIDS_DIR) \
	  --index $(INDEX) \
	  --sleep 2 --jitter 0.5

# Fetch attendees HTML for each raid in raids_index.csv.
pull-attendees: check-cookie
	$(PYTHON) $(SCRIPTS)/pull_raid_attendees.py \
	  --cookies-file $(COOKIES) \
	  --index $(INDEX) \
	  --out-dir $(RAIDS_DIR) \
	  --sleep 2 --jitter 0.5

# Upload saved raids to Supabase: insert into raids table, then each raid's events/loot/attendance.
# Loads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env / web/.env.
upload-raids:
	$(PYTHON) $(SCRIPTS)/upload_saved_raids_supabase.py \
	  --raids-dir $(RAIDS_DIR) \
	  --index $(INDEX) \
	  --apply
	$(PYTHON) $(SCRIPTS)/upload_all_raid_details_from_index.py \
	  --raids-dir $(RAIDS_DIR) \
	  --index $(INDEX)

# Upload only specific raid IDs to Supabase (e.g. make upload-raids-ids RAID_IDS=1598692,1598705). Skips others.
upload-raids-ids:
	@test -n "$(RAID_IDS)" || (echo "Usage: make upload-raids-ids RAID_IDS=1598692,1598705"; exit 1)
	$(PYTHON) $(SCRIPTS)/upload_saved_raids_supabase.py \
	  --raids-dir $(RAIDS_DIR) \
	  --index $(INDEX) \
	  --raid-ids "$(RAID_IDS)" \
	  --apply
	$(PYTHON) $(SCRIPTS)/upload_all_raid_details_from_index.py \
	  --raids-dir $(RAIDS_DIR) \
	  --index $(INDEX) \
	  --raid-ids "$(RAID_IDS)"

# One-off: upload a single raid's detail (e.g. make upload-raid-detail RAID_ID=1598705).
upload-raid-detail:
	@test -n "$(RAID_ID)" || (echo "Usage: make upload-raid-detail RAID_ID=1598705"; exit 1)
	$(PYTHON) $(SCRIPTS)/upload_raid_detail_to_supabase.py \
	  --raid-id $(RAID_ID) \
	  --raids-dir $(RAIDS_DIR) \
	  --apply

# Full sync: pull (since .raids-since-date) -> pull attendees -> prompt to confirm -> upload.
sync-raids: pull-raids pull-attendees
	@echo ""; echo "Raids with both detail + attendees (would be uploaded):"; \
	for id in $$(tail -n +2 $(INDEX) 2>/dev/null | cut -d',' -f1 | tr -d '"'); do \
	  if [ -f "$(RAIDS_DIR)/raid_$$id.html" ] && [ -f "$(RAIDS_DIR)/raid_$$id_attendees.html" ]; then echo "  $$id"; fi; \
	done; \
	echo ""; read -p "Upload these to Supabase? (y/n) " confirm; \
	if [ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ]; then $(MAKE) upload-raids; else echo "Upload skipped."; fi

# Download Current Member DKP page from Gamer Launch (requires cookies.txt).
MEMBERS_HTML := data/members_dkp.html
MEMBERS_SNAPSHOT := data/members_dkp_snapshot.json
AUDIT_SQL := docs/audit_dkp_snapshot_vs_db.sql

pull-members-dkp: check-cookie
	$(PYTHON) $(SCRIPTS)/pull_members_dkp.py --cookies-file $(COOKIES) --out $(MEMBERS_HTML)
	@echo "Saved to $(MEMBERS_HTML). Run 'make audit-dkp' to parse and compare to Supabase."

# Download members page, parse to snapshot, emit audit SQL, then run audit vs Supabase. Exit 0 = match.
audit-dkp: check-cookie pull-members-dkp
	$(PYTHON) $(SCRIPTS)/parse_members_dkp_html.py parse $(MEMBERS_HTML) -o $(MEMBERS_SNAPSHOT) --emit-sql $(AUDIT_SQL)
	$(PYTHON) $(SCRIPTS)/parse_members_dkp_html.py audit $(MEMBERS_SNAPSHOT) --json-out data/audit_dkp_result.json
