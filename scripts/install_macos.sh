#!/usr/bin/env bash
# Build และติดตั้ง OptiFleet AI Agent เป็น launchd daemon
# ต้องรันด้วย sudo daemon จะถูกลงทะเบียนภายใต้ label ปกติและมองเห็นได้ผ่าน
# `launchctl list` / Activity Monitor — สคริปต์นี้ไม่ได้พยายามซ่อนมัน
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run with sudo/root." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
EXE_PATH="$BIN_DIR/optifleet-agent"
CONFIG_PATH="$REPO_ROOT/configs/agent.yaml"

echo "Building agent..."
mkdir -p "$BIN_DIR"
(
  cd "$REPO_ROOT"
  CGO_ENABLED=0 go build -ldflags "-s -w" -o "$EXE_PATH" ./cmd/agent
)

if [[ ! -x "$EXE_PATH" ]]; then
  echo "Build failed: $EXE_PATH was not produced." >&2
  exit 1
fi

echo "Installing service (visible via 'launchctl list | grep optifleet')..."
"$EXE_PATH" -service install -config "$CONFIG_PATH"

echo "Starting service..."
"$EXE_PATH" -service start -config "$CONFIG_PATH"

echo ""
echo "Done. Verify with: launchctl list | grep -i optifleet"
echo "Secrets: set OPTIFLEET_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET in the launchd"
echo "plist's EnvironmentVariables (or via your secrets manager) — do not"
echo "hardcode them in agent.yaml."
