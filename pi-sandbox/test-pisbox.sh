#!/usr/bin/env bash
# test-pisbox.sh — non-interactive smoke test for psb.
# Runs real bwrap sandboxes via PSB_CMD=sh and checks the spec's assertions:
#   1. write to /etc fails, write to workspace succeeds
#   2. $HOME/.ssh appears empty inside
#   3. node + pi --version work inside
#   4. --net none: TCP egress fails (skippable if host has no network)
#   5. --dry-run prints a bwrap command with the expected flags
set -euo pipefail

cd "$(dirname "$0")"
PISBOX="$PWD/psb"

PASS=0 FAIL=0 SKIP=0
ok()   { echo "  ok: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1" >&2; FAIL=$((FAIL+1)); }
skip() { echo "  skip: $1"; SKIP=$((SKIP+1)); }

# ---------- setup: throwaway git repo under /tmp ----------
TMPROOT="$(mktemp -d)"
SBNAME="pisbox-test-$$"
cleanup() {
  rm -rf "$TMPROOT" "$HOME/workspaces/sandbox/$SBNAME"
}
trap cleanup EXIT

REPO="$TMPROOT/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q .
echo hello > "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init

# Create the sandboxed repo copy once; all runs below reuse it.
PSB_CMD=sh "$PISBOX" -n "$SBNAME" "$REPO" -c 'true'

# run <shell snippet> — exec `sh -c '<snippet>'` inside a pisbox sandbox on the
# repo copy. A failing run is reported as RUN_FAILED output instead of aborting
# the whole suite via set -e.
run() {
  local out rc
  out="$(PSB_CMD=sh "$PISBOX" -n "$SBNAME" --reuse "$REPO" -c "$1" 2>&1)" && rc=0 || rc=$?
  if [ $rc -ne 0 ]; then echo "RUN_FAILED(rc=$rc): $out"; else printf '%s\n' "$out"; fi
}

echo "test-pisbox: setup done (repo=$REPO, sandbox name=$SBNAME)"

# ---------- assertion 1: /etc read-only, workspace writable ----------
echo "[1] host read-only except workspace"
out="$(run 'touch /etc/pisbox-test-fail 2>/dev/null && echo ETC_WRITABLE || echo ETC_RO; echo data > ws-write.txt && cat ws-write.txt')"
if grep -q '^ETC_RO$' <<<"$out" && grep -q '^data$' <<<"$out"; then ok "write to /etc fails, write to workspace succeeds"; else bad "unexpected output: $out"; fi

# ---------- assertion 2: ~/.ssh masked (empty) inside ----------
echo "[2] \$HOME/.ssh appears empty inside"
if [ -e "$HOME/.ssh" ]; then
  out="$(run '[ -d "$HOME/.ssh" ] && [ -z "$(ls -A "$HOME/.ssh")" ] && echo SSH_EMPTY || echo SSH_NOT_EMPTY')"
  if grep -q '^SSH_EMPTY$' <<<"$out"; then ok "~/.ssh is empty inside sandbox"; else bad "unexpected output: $out"; fi
else
  skip "no ~/.ssh on host"
fi

# ---------- assertion 3: node + pi work inside ----------
echo "[3] node and pi run inside the sandbox"
if command -v node >/dev/null && command -v pi >/dev/null; then
  out="$(run 'node --version >/dev/null && pi --version >/dev/null && echo TOOLS_OK')"
  if grep -q '^TOOLS_OK$' <<<"$out"; then ok "node + pi --version succeed inside"; else bad "unexpected output: $out"; fi
else
  skip "node or pi not on host PATH"
fi

# ---------- assertion 4: --net none blocks TCP egress (skippable) ----------
echo "[4] --net none blocks egress"
if ! command -v curl >/dev/null; then
  skip "curl not available"
elif ! curl -m 5 -s https://example.com >/dev/null 2>&1; then
  skip "host has no network — cannot verify egress is blocked"
else
  out="$(PSB_CMD=sh "$PISBOX" -n "$SBNAME" --reuse --net none "$REPO" \
    -c 'curl -m 5 -s https://example.com >/dev/null 2>&1 && echo NET_OK || echo NET_BLOCKED')"
  if grep -q '^NET_BLOCKED$' <<<"$out"; then ok "TCP egress fails under --net none"; else bad "unexpected output: $out"; fi
fi

# ---------- assertion 5: --dry-run prints expected bwrap command ----------
echo "[5] --dry-run output contains expected flags"
DRYNAME="pisbox-dryrun-$$"
out="$(PSB_CMD=sh "$PISBOX" -n "$DRYNAME" --scratch --net none --mask /etc/hostname --dry-run "$REPO" --prompt hello)"
rm -rf "$HOME/workspaces/sandbox/$DRYNAME"
ws="$HOME/workspaces/sandbox/$DRYNAME"
fail=0
# resolv.conf may be a symlink; pisbox binds its resolved target
RESOLV="$(readlink -f /etc/resolv.conf)"
for want in 'bwrap' '--ro-bind / /' "--bind $ws $ws" '--tmpfs /tmp' \
            '--unshare-pid' '--unshare-ipc' '--unshare-uts' '--unshare-net' \
            "$RESOLV" '--chdir'; do
  grep -qF -- "$want" <<<"$out" || { bad "dry-run output missing: $want"; fail=1; }
done
[ $fail = 0 ] && ok "dry-run command contains all expected flags"

# ---------- summary ----------
echo
echo "passed=$PASS failed=$FAIL skipped=$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
echo "test-pisbox: ALL PASS"
