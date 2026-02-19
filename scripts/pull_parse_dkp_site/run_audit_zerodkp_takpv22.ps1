# Run 0 DKP roll audit on TAKPv22 + optional rotated EQ logs for the raiding character set.
# Uses dkp/data and only scans eqlog_{name}_loginse*.txt (current and rotated).
# Run from repo root: .\scripts\pull_parse_dkp_site\run_audit_zerodkp_takpv22.ps1
# Optional: set $eqRotatedLogs to a path like ...\Desktop\old\EQ to include rotated logs.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dkpRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$takpDir = Join-Path (Split-Path -Parent $dkpRoot) "TAKPv22"
$dataDir = Join-Path $dkpRoot "data"
$chars = "Ammomage,Animalammo,Ammordius,Badammo,Chealfo,Healammo,Deathfo,Malosammo,Iaminae,Ezram,Tappyammo"

# Optional second directory for rotated logs (eqlog_*_loginse_YYYYMMDD_HHMMSS.txt)
$eqRotatedLogs = Join-Path $env:USERPROFILE "OneDrive\Desktop\old\EQ"
if (-not (Test-Path -LiteralPath $eqRotatedLogs -PathType Container)) {
    $eqRotatedLogs = $null
}

if (-not (Test-Path -LiteralPath $takpDir -PathType Container)) {
    Write-Error "Logs directory not found: $takpDir"
    exit 1
}
if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) {
    Write-Error "Data directory not found: $dataDir"
    exit 1
}

Set-Location $dkpRoot
$logArgs = @("--logs", $takpDir)
if ($eqRotatedLogs) { $logArgs += @("--logs", $eqRotatedLogs) }
python scripts/pull_parse_dkp_site/audit_log_zerodkp_rolls.py @logArgs --data $dataDir --characters $chars
