#!/usr/bin/env bash
# Watches a subagent through outside signals only (never reads its transcript).
# Prints one line only when something changes the decision: a new commit, a branch change,
# or nothing touched for N minutes. Made for Monitor (each line = one notice).
# Usage: watch.sh <repo> [extra-dir] [idle-minutes=10]
repo="$1"; extra="${2:-}"; idle_min="${3:-10}"
commit0=$(git -C "$repo" rev-parse HEAD 2>/dev/null)
branch0=$(git -C "$repo" branch --show-current 2>/dev/null)
stamp=$(mktemp); last=$(date +%s); start=$last; warned=0; parent=$PPID
# Monitor expires at 30 min, but on Windows the loop can outlive it: exit by itself at 31 min or when the parent dies.
trap 'rm -f "$stamp"' EXIT
while true; do
  sleep 180
  [ $(( $(date +%s) - start )) -ge 1860 ] && exit 0
  kill -0 "$parent" 2>/dev/null || exit 0
  fresh=$(mktemp)
  n=$(find "$repo" ${extra:+"$extra"} \( -name node_modules -o -name .git -o -name out \) -prune \
        -o -type f -newer "$stamp" -print 2>/dev/null | wc -l)
  mv -f "$fresh" "$stamp"
  now=$(date +%s)
  [ "$n" -gt 0 ] && { last=$now; warned=0; }
  c=$(git -C "$repo" rev-parse HEAD 2>/dev/null)
  if [ -n "$c" ] && [ "$c" != "$commit0" ]; then
    git -C "$repo" log --oneline "$commit0..$c" 2>/dev/null | sed 's/^/new commit: /'
    commit0=$c
  fi
  b=$(git -C "$repo" branch --show-current 2>/dev/null)
  [ "$b" != "$branch0" ] && { echo "branch changed: $branch0 -> $b"; branch0=$b; }
  if [ $((now - last)) -ge $((idle_min * 60)) ] && [ $warned -eq 0 ]; then
    echo "IDLE? no file touched for ${idle_min} min"; warned=1
  fi
done
