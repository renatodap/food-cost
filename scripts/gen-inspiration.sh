#!/usr/bin/env bash
# Generate the UI inspiration boards with GPT Image 2 (curl — the local
# python3.14 has a broken pyexpat, so the skill's script can't run here).
#
# Four deliberately DIFFERENT directions, not four variations of one. The point
# is to have something to choose between and to argue with; a board where every
# option is the same idea at different saturations teaches nothing.
set -uo pipefail

KEY=$(grep '^OPENAI_API_KEY=' "$HOME/.claude/skills/generate-image/.env" | cut -d= -f2- | tr -d '"'"'"' \r\n')
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/inspiration"
mkdir -p "$OUT"

gen() {
  local name="$1" prompt="$2"
  echo "==> $name"
  curl -sS https://api.openai.com/v1/images/generations \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg p "$prompt" '{model:"gpt-image-2", prompt:$p, size:"1536x1024", quality:"high"}')" \
    -o "/tmp/img-$name.json"
  if jq -e '.data[0].b64_json' "/tmp/img-$name.json" >/dev/null 2>&1; then
    jq -r '.data[0].b64_json' "/tmp/img-$name.json" | base64 -d > "$OUT/$name.png"
    echo "    [ok] $OUT/$name.png ($(du -h "$OUT/$name.png" | cut -f1))"
  else
    echo "    [FAIL] $(jq -c '.error // .' "/tmp/img-$name.json" | head -c 300)"
  fi
}

COMMON="Screenshot of a desktop web application UI, rendered crisply at high fidelity, flat vector UI design (not a photograph of a screen, no browser chrome, no mockup device frame). The app is a personal food-spending analytics tool that links meals eaten to money spent."

gen receipt-paper "$COMMON Design direction: THE RECEIPT. Warm off-white thermal receipt paper background (#FAF7F0), everything set in a refined monospace with tabular figures. A left column lists meals as receipt lines with dot leaders running to right-aligned prices. Subtle horizontal hairlines like perforations. One accent color only: a deep ink red used for an approval stamp motif. Large serif display number showing '\$1,284' as the month total with a small caption 'spend attributed to 214 meals'. A restrained horizontal bar chart comparing breakfast, lunch, dinner. Generous whitespace, tiny uppercase letterspaced labels, no gradients, no drop shadows, no rounded card soup. Editorial and quiet."

gen dark-editorial "$COMMON Design direction: DARK EDITORIAL KITCHEN. Near-black charcoal background (#0E0E0F) with warm amber and burnt-orange accents. Big elegant high-contrast serif headline 'Cost per plate'. A dense data table of meals with right-aligned tabular prices and small circular coverage indicators (partial rings showing what fraction of a meal's cost is known). A layered area chart of daily food spend split by breakfast/lunch/dinner in three warm tones. Thin 1px borders, no glow, no neon, no glassmorphism. Feels like a well-set financial newspaper at night."

gen ledger-grid "$COMMON Design direction: ANALYTICAL LEDGER GRID. Cream paper (#F5F1E8) with ink-black type and a single sage-green accent. The whole layout is a strict visible grid of hairline rules, like a hand-ruled accounting ledger. Left: a reconciliation review queue of proposed matches, each row pairing a receipt line ('CHKN BRST 2.34LB \$12.40') with a meal entry ('Chicken Breast 180g') and a confidence percentage. Right: a small multiples chart — seven tiny sparkline panels, one per weekday, showing spend by meal type. Confident use of small type sizes, lots of numbers, clear hierarchy. No cards, no shadows, no icons-as-decoration."

gen warm-minimal "$COMMON Design direction: WARM MINIMAL. Soft bone-white background with terracotta, olive and clay accents. A calm dashboard: one hero stat 'Dinner averages \$8.40' in large light-weight sans, a smooth stacked area chart of monthly food spend, and a horizontal 'attribution coverage' meter showing 68 percent filled. Below, a grid of meal cards each with a small photo thumbnail, the meal name, and its cost. Rounded but not bubbly, one level of elevation maximum, muted natural palette, plenty of breathing room. Scandinavian restraint, not startup-generic."

echo "done."
