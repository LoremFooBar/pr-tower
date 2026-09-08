#!/bin/sh
# Keep the internal Socket Firewall proxy out of the repository, which is public.
#
# npm writes the proxy URL into every "resolved" line of package-lock.json.
# pnpm's lockfile records integrity hashes and names no registry at all, so
# under pnpm the rewrite below normally finds nothing and this stands as a
# guard. It rewrites a lockfile, and refuses the commit for anything else:
# outside a lockfile there is no safe guess about what the URL should become.

PROXY='your-mirror\.example/npm/'
CANONICAL='https://registry.npmjs.org/'

for lock in pnpm-lock.yaml package-lock.json; do
  [ -f "$lock" ] || continue
  grep -q "$PROXY" "$lock" || continue
  perl -i -pe "s{https://$PROXY}{$CANONICAL}g" "$lock"
  git add "$lock"
  echo "normalize-lockfile: rewrote proxy URLs in $lock"
done

leaks=$(git diff --cached --name-only --diff-filter=ACM | while IFS= read -r f; do
  { [ -f "$f" ] && grep -Iq 'your-mirror\.example' "$f" 2>/dev/null && printf '  %s\n' "$f"; } || true
done)

if [ -n "$leaks" ]; then
  echo "normalize-lockfile: an internal host is staged, and this repository is public:"
  echo "$leaks"
  exit 1
fi
