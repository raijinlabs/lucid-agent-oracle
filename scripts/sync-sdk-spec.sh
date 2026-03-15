#!/usr/bin/env bash
set -euo pipefail

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDK_REPO="${SDK_REPO:-$MONO_ROOT/../oracle-sdk-node}"

if [ ! -d "$SDK_REPO" ]; then
  echo "ERROR: SDK repo not found at $SDK_REPO"
  echo "Set SDK_REPO env var to the oracle-sdk-node directory"
  exit 1
fi

echo "Exporting OpenAPI spec..."
CURSOR_SECRET=test npx tsx "$MONO_ROOT/scripts/export-openapi.ts" > "$SDK_REPO/openapi/openapi.json"

# Verify endpoint count
COUNT=$(node -e "const s=JSON.parse(require('fs').readFileSync('$SDK_REPO/openapi/openapi.json','utf8'));let c=0;for(const[,m]of Object.entries(s.paths))c+=Object.keys(m).length;console.log(c)")
if [ "$COUNT" -ne 15 ]; then
  echo "ERROR: Expected 15 endpoints, got $COUNT"
  exit 1
fi

echo "OK: synced $COUNT endpoints to $SDK_REPO/openapi/openapi.json"
