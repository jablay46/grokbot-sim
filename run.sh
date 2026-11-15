#!/usr/bin/env bash
# GrokBot-Sim runner — PAPER TRADING ONLY. No real money, no keys, no signing.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$DIR/../node22/bin/node"
if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi
exec "$NODE" "$DIR/src/run.mjs" "$@"
