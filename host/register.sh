#!/bin/bash
# Register Shunt Native Messaging host for Helium browser
# Usage: bash register.sh

set -eu

BINARY="$(cd "$(dirname "$0")" && pwd)/target/release/shunt-host"
MANIFEST_DIR="$HOME/Library/Application Support/net.imput.helium/NativeMessagingHosts"
MANIFEST="$MANIFEST_DIR/com.opensetsuna.shunt.json"

if [ ! -f "$BINARY" ]; then
  echo "Binary not found at $BINARY" >&2
  echo "Run 'cd host && cargo build --release' first." >&2
  exit 1
fi

mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST" <<JSON
{
  "name": "com.opensetsuna.shunt",
  "description": "Shunt — browser automation transport for Helium",
  "type": "stdio",
  "path": "$BINARY",
  "allowed_origins": [
    "chrome-extension://fbhbfpbbnppjecdlinnannjojfeimljb/"
  ]
}
JSON

echo "Registered: $MANIFEST"
