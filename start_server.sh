#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/backend"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -r requirements.txt

export METRO_MODEL_URL="${METRO_MODEL_URL:-http://127.0.0.1:48010/v1}"
export METRO_MODEL_NAME="${METRO_MODEL_NAME:-gemma-4-31b-it}"

python app.py
