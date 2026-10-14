#!/bin/bash
# One-command build: run every test, then assemble a publishable static site in ../_site
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "=== 1/3 unit tests (offline) ==="
for t in engine data ai providers; do printf '%-24s' "tests/$t.test.js"; node "tests/$t.test.js" >"/tmp/build_$t.log" 2>&1 && echo "OK" || { echo "FAILED"; tail -20 "/tmp/build_$t.log"; exit 1; }; done
echo "=== 2/3 syntax check (node --check) ==="
for f in js/*.js; do node --check "$f"; printf '%-24s OK\n' "$f"; done
echo "=== 3/3 build _site ==="
rm -rf "$ROOT/../_site" && mkdir -p "$ROOT/../_site"
cp -r index.html css js README.md "$ROOT/../_site/"
touch "$ROOT/../_site/.nojekyll"
echo "built: $(du -sh "$ROOT/../_site" | cut -f1) -> ../_site"
find "$ROOT/../_site" -type f | sort
