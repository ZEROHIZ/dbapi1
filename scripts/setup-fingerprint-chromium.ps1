param(
  [string]$Version = "latest",
  [string]$InstallRoot = ".cache/fingerprint-chromium"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetRoot = Join-Path $repoRoot $InstallRoot
New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

$pythonScript = @'
import json
import os
import sys
import time

import requests

version = sys.argv[1]
target_root = sys.argv[2]

if version == "latest":
    release_url = "https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest"
else:
    release_url = f"https://api.github.com/repos/adryfish/fingerprint-chromium/releases/tags/{version}"

headers = {
    "User-Agent": "codex-setup-script",
    "Accept": "application/vnd.github+json",
}

release_resp = requests.get(release_url, headers=headers, timeout=60)
release_resp.raise_for_status()
release = release_resp.json()

asset = next((item for item in release.get("assets", []) if item["name"].lower().endswith("windows_x64.zip")), None)
if not asset:
    raise SystemExit(f"No Windows x64 ZIP asset found in release {release.get('tag_name', '')}.")

os.makedirs(target_root, exist_ok=True)

archive_path = os.path.join(target_root, asset["name"])
version_dir = os.path.join(target_root, release["tag_name"])
expected_size = int(asset["size"])
download_headers = {
    "User-Agent": "codex-setup-script",
    "Accept": "application/octet-stream",
}

for attempt in range(1, 16):
    current_size = os.path.getsize(archive_path) if os.path.exists(archive_path) else 0
    if current_size >= expected_size:
        break

    request_headers = dict(download_headers)
    file_mode = "wb"
    if current_size > 0:
        request_headers["Range"] = f"bytes={current_size}-"
        file_mode = "ab"

    try:
        with requests.get(asset["browser_download_url"], headers=request_headers, stream=True, timeout=120) as download_resp:
            if download_resp.status_code not in (200, 206):
                raise RuntimeError(f"Unexpected status: {download_resp.status_code}")

            with open(archive_path, file_mode) as file_handle:
                for chunk in download_resp.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        file_handle.write(chunk)
    except Exception as exc:
        print(f"attempt {attempt} interrupted: {exc}", file=sys.stderr)
        time.sleep(2)

final_size = os.path.getsize(archive_path) if os.path.exists(archive_path) else 0
if final_size < expected_size:
    raise SystemExit("Download incomplete after retries.")

print(json.dumps({
    "tag": release["tag_name"],
    "archive_path": archive_path,
    "version_dir": version_dir,
}))
'@

$pythonFile = Join-Path $env:TEMP "codex_setup_fingerprint_chromium.py"
Set-Content -Path $pythonFile -Value $pythonScript -Encoding UTF8

try {
  $result = & python $pythonFile $Version $targetRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Download step failed."
  }

  $downloadInfo = $result | ConvertFrom-Json
  $versionDir = $downloadInfo.version_dir
  $archivePath = $downloadInfo.archive_path

  if (-not (Test-Path $versionDir)) {
    New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
  }

  $chromePath = Get-ChildItem -Path $versionDir -Recurse -Filter chrome.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if (-not $chromePath) {
    Expand-Archive -Path $archivePath -DestinationPath $versionDir -Force
    $chromePath = Get-ChildItem -Path $versionDir -Recurse -Filter chrome.exe | Select-Object -First 1 -ExpandProperty FullName
  }

  if (-not $chromePath) {
    throw "chrome.exe was not found after extraction. Please inspect $versionDir."
  }

  Write-Host ""
  Write-Host "fingerprint-chromium is ready."
  Write-Host "Version: $($downloadInfo.tag)"
  Write-Host "Executable: $chromePath"
} finally {
  if (Test-Path $pythonFile) {
    Remove-Item -Force $pythonFile
  }
}
