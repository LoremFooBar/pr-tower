#!/bin/sh
# Keep a private registry mirror out of the repository, which is public.
#
# The mirror is read from npm config rather than named here: writing the host
# into a public repository is the very thing this hook exists to prevent. Anyone
# installing straight from registry.npmjs.org gets a no-op.
#
# npm writes the mirror into every "resolved" line of package-lock.json. pnpm's
# lockfile records integrity hashes and names no registry, so under pnpm the
# rewrite normally finds nothing and this stands as a guard. It fixes a
# lockfile and refuses anything else: outside a lockfile there is no safe guess
# about what such a URL should become.

CANONICAL='https://registry.npmjs.org/'

REGISTRY=$(npm config get registry 2>/dev/null | tr -d '\r')
case "$REGISTRY" in
  ''|undefined|null|"$CANONICAL"|https://registry.npmjs.org*) exit 0 ;;
esac
HOST=$(printf '%s' "$REGISTRY" | sed -E 's#^[a-zA-Z]+://([^/]+).*#\1#')
[ -n "$HOST" ] || exit 0

for lock in pnpm-lock.yaml package-lock.json; do
  [ -f "$lock" ] || continue
  grep -Fq "$HOST" "$lock" || continue
  perl -i -pe "s{\Q$REGISTRY\E}{$CANONICAL}g" "$lock"
  git add "$lock"
  echo "normalize-lockfile: rewrote $HOST to the canonical registry in $lock"
done

leaks=$(git diff --cached --name-only --diff-filter=ACM | while IFS= read -r f; do
  { [ -f "$f" ] && grep -IFq "$HOST" "$f" 2>/dev/null && printf '  %s\n' "$f"; } || true
done)

if [ -n "$leaks" ]; then
  echo "normalize-lockfile: your registry mirror is named in staged files, and this repository is public:"
  echo "$leaks"
  exit 1
fi
