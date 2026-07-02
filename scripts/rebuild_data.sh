#!/usr/bin/env bash
# Rebuild every generated file under data/ from the rulebook PDFs, in
# dependency order, then verify the result. Requires the gitignored PDFs in
# the repo root (or SOTDL_PDF_DIR) and `pip install -r requirements.txt`.
#
#   scripts/rebuild_data.sh            # everything except the LLM enrichment pass
#   scripts/rebuild_data.sh --enrich   # also run enrich_spells.py (claude -p; resumable)

set -euo pipefail
cd "$(dirname "$0")/.."

python3 scripts/extract_text.py
python3 scripts/parse_spells.py
python3 scripts/tag_spells.py
if [[ "${1:-}" == "--enrich" ]]; then
  python3 scripts/enrich_spells.py
else
  echo "skipping enrich_spells.py (LLM pass; opt in with --enrich) — keeping committed data/spell-enrichment.json"
fi
python3 scripts/score_spells.py    # before detect_combos.py, which reads spell-scores.json
python3 scripts/detect_combos.py
python3 scripts/parse_paths.py
python3 scripts/parse_traditions.py
python3 scripts/parse_equipment.py
python3 scripts/parse_creatures.py
python3 scripts/parse_rules_index.py

npm test
