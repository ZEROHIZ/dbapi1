#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-latest}"
INSTALL_ROOT="${2:-.cache/fingerprint-chromium}"

for cmd in curl find grep head mkdir node tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 127
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_ROOT="$REPO_ROOT/$INSTALL_ROOT"

mkdir -p "$TARGET_ROOT"

if [[ "$VERSION" == "latest" ]]; then
  RELEASE_URL="https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest"
else
  RELEASE_URL="https://api.github.com/repos/adryfish/fingerprint-chromium/releases/tags/$VERSION"
fi

RELEASE_JSON="$(curl -fsSL -H 'User-Agent: codex-setup-script' "$RELEASE_URL")"

TAG_NAME="$(printf '%s' "$RELEASE_JSON" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.tag_name || '');")"
ASSET_NAME="$(printf '%s' "$RELEASE_JSON" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); const asset=(data.assets||[]).find(item=>/x86_64_linux\\.tar\\.xz$/.test(item.name)); process.stdout.write(asset ? asset.name : '');")"
ASSET_URL="$(printf '%s' "$RELEASE_JSON" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); const asset=(data.assets||[]).find(item=>/x86_64_linux\\.tar\\.xz$/.test(item.name)); process.stdout.write(asset ? asset.browser_download_url : '');")"

if [[ -z "$TAG_NAME" || -z "$ASSET_NAME" || -z "$ASSET_URL" ]]; then
  echo "Failed to resolve Linux release asset from GitHub." >&2
  exit 1
fi

VERSION_DIR="$TARGET_ROOT/$TAG_NAME"
ARCHIVE_PATH="$TARGET_ROOT/$ASSET_NAME"

mkdir -p "$VERSION_DIR"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "Downloading $ASSET_NAME..."
  curl -fL -H 'User-Agent: codex-setup-script' -o "$ARCHIVE_PATH" "$ASSET_URL"
else
  echo "Archive already exists: $ARCHIVE_PATH"
fi

if ! find "$VERSION_DIR" -type f \( -name chrome -o -name ungoogled-chromium \) | grep -q .; then
  echo "Extracting to $VERSION_DIR..."
  tar -xJf "$ARCHIVE_PATH" -C "$VERSION_DIR"
else
  echo "Extracted files already exist in: $VERSION_DIR"
fi

CHROME_PATH="$(find "$VERSION_DIR" -type f \( -name chrome -o -name ungoogled-chromium \) | head -n 1)"

if [[ -z "$CHROME_PATH" ]]; then
  echo "Could not find browser executable after extraction: $VERSION_DIR" >&2
  exit 1
fi

echo
echo "fingerprint-chromium is ready."
echo "Version: $TAG_NAME"
echo "Executable: $CHROME_PATH"
