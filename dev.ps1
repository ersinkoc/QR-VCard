[CmdletBinding()]
param(
  [switch]$SkipSeed
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$directusUrl = 'http://127.0.0.1:18055'
$composeFile = Join-Path $PSScriptRoot 'directus/docker-compose.yml'

function Test-DirectusReady {
  try {
    $response = Invoke-WebRequest -Uri "$directusUrl/server/ping" -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  }
  catch {
    return $false
  }
}

foreach ($command in 'docker', 'npm.cmd') {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "'$command' was not found on PATH. Install/start Docker Desktop and Node.js, then retry."
  }
}

if (-not (Test-DirectusReady)) {
  Write-Host "[dev] Directus is not ready at $directusUrl; starting Docker Compose..." -ForegroundColor Yellow
  & docker compose -f $composeFile up --detach --wait
  if ($LASTEXITCODE -ne 0) {
    throw "Directus failed to start (docker compose exited $LASTEXITCODE)."
  }
}

if (-not (Test-DirectusReady)) {
  throw "Directus did not answer $directusUrl/server/ping after Docker Compose reported ready."
}

if (-not $SkipSeed) {
  Write-Host '[dev] Bootstrapping Directus schema, accounts, and demo cards...' -ForegroundColor Cyan
  & npm.cmd run directus:bootstrap
  if ($LASTEXITCODE -ne 0) {
    throw "Directus bootstrap failed (npm exited $LASTEXITCODE)."
  }
}

Write-Host '[dev] Opening http://localhost:5173/panel and starting Vite + API. Press Ctrl+C to stop them.' -ForegroundColor Green
& npm.cmd run dev:all -- --open
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
