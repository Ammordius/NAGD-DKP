# Local raid pull & upload (Windows, no make required).
# Cookie in cookies.txt; Supabase in .env or web/.env.
# Since-date is read/updated in .raids-since-date (one line YYYY-MM-DD). Default 2026-02-27.
#
# Usage (run from repo root in PowerShell):
#   .\raids.ps1 pull-raids
#   .\raids.ps1 pull-raids-ids 1598692 1598705
#   .\raids.ps1 pull-attendees
#   .\raids.ps1 upload-raids
#   .\raids.ps1 upload-raids-ids 1598692 1598705
#   .\raids.ps1 sync-raids   # pull -> pull attendees -> confirm -> upload
#   .\raids.ps1 pull-members-dkp   # download Current Member DKP page
#   .\raids.ps1 audit-dkp          # download + parse + audit vs Supabase

param(
    [Parameter(Position = 0)]
    [string]$Target = "help",
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$RaidIds = @()
)

$ErrorActionPreference = "Stop"
$ScriptDir = "scripts/pull_parse_dkp_site"
$Cookies = "cookies.txt"
$RaidsDir = "raids"
$Index = "raids_index.csv"
$SinceDateFile = ".raids-since-date"
$DefaultSinceDate = "2026-02-27"
$LimitPages = 1

# RaidIds as single string for Python (comma-separated)
function Get-RaidIdsStr { ($RaidIds | Where-Object { $_ }) -join "," }

function Get-SinceDate {
    if (Test-Path $SinceDateFile) {
        $d = (Get-Content $SinceDateFile -Raw).Trim()
        if ($d -match '^\d{4}-\d{2}-\d{2}$') { return $d }
    }
    return $DefaultSinceDate
}

function Set-SinceDateToToday {
    (Get-Date).ToString("yyyy-MM-dd") | Set-Content $SinceDateFile -NoNewline
    Write-Host "Updated $SinceDateFile to $(Get-Date -Format 'yyyy-MM-dd')"
}

function Check-Cookie {
    if (-not (Test-Path $Cookies)) {
        Write-Error "Create $Cookies with your GamerLaunch Cookie header (one line). Do not commit."
    }
}

function Pull-Raids {
    Check-Cookie
    $since = Get-SinceDate
    Write-Host "Pulling raids since $since (page 1 only)..."
    python $ScriptDir/pull_raids.py `
        --since-date $since `
        --limit-pages $LimitPages `
        --cookies-file $Cookies `
        --out-dir $RaidsDir `
        --index $Index `
        --sleep 2 --jitter 0.5
    if ($LASTEXITCODE -eq 0) { Set-SinceDateToToday }
}

function Pull-RaidsIds {
    $ids = Get-RaidIdsStr
    if (-not $ids) { Write-Error "Usage: .\raids.ps1 pull-raids-ids 1598692 1598705" }
    Check-Cookie
    python $ScriptDir/pull_raids.py `
        --raid-ids $ids `
        --cookies-file $Cookies `
        --out-dir $RaidsDir `
        --index $Index `
        --sleep 2 --jitter 0.5
}

function Pull-Attendees {
    Check-Cookie
    python $ScriptDir/pull_raid_attendees.py `
        --cookies-file $Cookies `
        --index $Index `
        --out-dir $RaidsDir `
        --sleep 2 --jitter 0.5
}

function Upload-Raids {
    python $ScriptDir/upload_saved_raids_supabase.py `
        --raids-dir $RaidsDir `
        --index $Index `
        --apply
    python $ScriptDir/upload_all_raid_details_from_index.py `
        --raids-dir $RaidsDir `
        --index $Index
}

function Upload-RaidsIds {
    $ids = Get-RaidIdsStr
    if (-not $ids) { Write-Error "Usage: .\raids.ps1 upload-raids-ids 1598692 1598705" }
    python $ScriptDir/upload_saved_raids_supabase.py `
        --raids-dir $RaidsDir `
        --index $Index `
        --raid-ids $ids `
        --apply
    python $ScriptDir/upload_all_raid_details_from_index.py `
        --raids-dir $RaidsDir `
        --index $Index `
        --raid-ids $ids
}

function Upload-RaidDetail {
    $id = Get-RaidIdsStr
    if (-not $id) { Write-Error "Usage: .\raids.ps1 upload-raid-detail 1598705" }
    python $ScriptDir/upload_raid_detail_to_supabase.py `
        --raid-id $id `
        --raids-dir $RaidsDir `
        --apply
}

function Sync-Raids {
    Pull-Raids
    Pull-Attendees
    Write-Host ""
    Write-Host "Raids in index with both detail + attendees (would be uploaded):"
    if (-not (Test-Path $Index)) { Write-Error "No $Index. Run pull-raids and pull-attendees first." }
    $csv = Import-Csv $Index
    $raidsDirPath = $RaidsDir
    $toUpload = @()
    foreach ($r in $csv) {
        $rid = ($r.raid_id -replace '"', '').Trim()
        if (-not $rid) { continue }
        $detail = Join-Path $raidsDirPath "raid_$rid.html"
        $att = Join-Path $raidsDirPath "raid_${rid}_attendees.html"
        if ((Test-Path $detail) -and (Test-Path $att)) { $toUpload += $rid }
    }
    if ($toUpload.Count -eq 0) {
        Write-Host "  (none - no raids have both detail and attendees HTML)"
        return
    }
    $toUpload | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    $confirm = Read-Host "Upload these $($toUpload.Count) raid(s) to Supabase? (y/n)"
    if ($confirm -eq 'y' -or $confirm -eq 'Y') {
        Upload-Raids
    } else {
        Write-Host "Upload skipped."
    }
}

function Pull-MembersDkp {
    Check-Cookie
    $outPath = "data/members_dkp.html"
    if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" | Out-Null }
    Write-Host "Downloading Current Member DKP page..."
    python $ScriptDir/pull_members_dkp.py --cookies-file $Cookies --out $outPath
    if ($LASTEXITCODE -eq 0) { Write-Host "Saved to $outPath. Run audit-dkp to parse and compare to Supabase." }
}

function Audit-Dkp {
    Pull-MembersDkp
    if ($LASTEXITCODE -ne 0) { return }
    $snapshot = "data/members_dkp_snapshot.json"
    $auditSql = "docs/audit_dkp_snapshot_vs_db.sql"
    $jsonOut = "data/audit_dkp_result.json"
    Write-Host "Parsing and emitting audit SQL..."
    python $ScriptDir/parse_members_dkp_html.py parse data/members_dkp.html -o $snapshot --emit-sql $auditSql
    if ($LASTEXITCODE -ne 0) { return }
    Write-Host "Running audit vs Supabase..."
    python $ScriptDir/parse_members_dkp_html.py audit $snapshot --json-out $jsonOut
}

function Show-Help {
    @"
Local raid pull & upload (Windows). Use this instead of make/nmake.

  .\raids.ps1 pull-raids              # page 1, since date in .raids-since-date (default 2026-02-27)
  .\raids.ps1 pull-raids-ids 1598692 1598705
  .\raids.ps1 pull-attendees
  .\raids.ps1 upload-raids
  .\raids.ps1 upload-raids-ids 1598692 1598705   # upload only these (spaces or commas)
  .\raids.ps1 sync-raids              # pull -> pull attendees -> confirm -> upload
  .\raids.ps1 upload-raid-detail 1598705
  .\raids.ps1 pull-members-dkp        # download Current Member DKP page
  .\raids.ps1 audit-dkp               # download + parse + audit vs Supabase

Since-date: edit .raids-since-date (one line YYYY-MM-DD). After each pull it is set to today.
Prereqs: cookies.txt (Cookie header), .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
"@
}

switch ($Target.ToLower()) {
    "pull-raids"       { Pull-Raids }
    "pull-raids-ids"   { Pull-RaidsIds }
    "pull-attendees"   { Pull-Attendees }
    "upload-raids"     { Upload-Raids }
    "upload-raids-ids" { Upload-RaidsIds }
    "upload-raid-detail" { Upload-RaidDetail }
    "sync-raids"       { Sync-Raids }
    "pull-members-dkp" { Pull-MembersDkp }
    "audit-dkp"        { Audit-Dkp }
    "help"             { Show-Help }
    default            { Show-Help; if ($Target -ne "help") { Write-Error "Unknown target: $Target" } }
}
