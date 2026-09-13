# pisbox — spec (v1)

One-command wrapper that runs `pi` in a bubblewrap sandbox on an isolated copy of a repo, with the host read-only and secrets masked. See ../sandbox-research.md for rationale.

## UX

```
pisbox [options] <repo-path | git-url> [pi args...]
pisbox --inplace [options] <repo-path> [pi args...]
pisbox help
```

- Default: copy the repo into `~/workspaces/sandbox/<name>` (name = `-n NAME` or basename of path/URL) and run pi there. The original is never touched.
  - Local dir with `.git`: `cp -a` (or `git clone --local`) — use `rsync -a --exclude .git` + keep .git? Simplest: `cp -a src/. dst/`.
  - Local dir without `.git`: still copy (`cp -a`).
  - git URL: `git clone <url> dst`.
- If target dir already exists and is non-empty → error, suggest `-n NAME` or `--reuse` (use existing dir as-is).
- `--inplace`: skip copying; bind the given path writable at its own absolute path. Warn that this writes to the real repo.
- `--net none`: add `--unshare-net` and shadow `/etc/resolv.conf` with an empty file created in a per-run tmp (see research pitfall #7 — DNS still resolves via systemd-resolved UDS otherwise).
- `--scratch`: give pi a fresh per-run state dir instead of the real `~/.pi` (bind scratch dir over `$HOME/.pi`). Default is to bind the real `~/.pi` writable so session history continues.
- `--mask EXTRA...`: extra paths to mask (space-separated, after the flag).
- `--dry-run`: print the bwrap command, don't exec.
- Remaining args pass through to pi verbatim.

## Sandbox construction (bwrap)

Mount order matters (later actions shadow earlier ones — research pitfall #2):

1. `--ro-bind / /`                      # host read-only by default
2. `--bind "$WORKSPACE" "$WORKSPACE"`   # writable repo, at its own absolute path (pitfall #1: cannot bind to a new path on ro root)
3. pi state: `--bind "$HOME/.pi" "$HOME/.pi"`  OR  scratch dir bound over it
4. `--dev /dev --proc /proc --tmpfs /tmp`     # writable binds above are NOT under /tmp, so order is safe; keep this pattern anyway
5. Secret masks LAST (so they shadow everything), each guarded by `[ -e path ]` (pitfall #8: bwrap creates missing mountpoints on the host):
   - dirs → `--tmpfs <dir>`: `$HOME/.ssh`, `$HOME/.aws`, `$HOME/.gnupg`, `$HOME/.config/gh`, `$HOME/.kube`, `$HOME/.docker`
   - files → `--ro-bind /dev/null <file>`: `$HOME/.netrc`, `$HOME/.npmrc` (may hold tokens), `$HOME/.git-credentials`
   - plus any `--mask` extras (dir→tmpfs, file→/dev/null)
6. Unshare set: `--unshare-user-try --unshare-pid --unshare-ipc --unshare-uts` (+ `--unshare-net` in no-net mode). Identity uid mapping is default → no git ownership issues (pitfall #5).

Env inside sandbox:
- `TMPDIR=/tmp` (real dir, not symlink — pitfall #4)
- `npm_config_cache=$TMPDIR/npm-cache` (pitfall #3)
- everything else inherited.

Then `--chdir "$WORKSPACE"` and run `pi "$@"` (not via `exec`, so the EXIT trap can clean up per-run temp artifacts).

## Files

- `pisbox` — bash script, `set -euo pipefail`, no deps beyond coreutils+git+bwrap. Executable.
- `README.md` — quickstart, flags, threat model (what IS protected: writes everywhere except workspace/pi-state; secrets masked; optional net-off), known limitations (host is otherwise *readable* — masked list is the exfil boundary; no domain-level egress control in v1).
- `test-pisbox.sh` — non-interactive smoke test that runs bwrap with the same construction and asserts:
  1. write to /etc fails, write to workspace succeeds
  2. `$HOME/.ssh` appears empty inside
  3. node + pi --version work inside
  4. `--net none`: TCP egress fails (curl to a known host times out/refused) — keep this test tolerant/skippable if no network
  5. dry-run prints a bwrap command containing the expected flags

## Non-goals (v1)

- No domain allowlist proxy, no seccomp, no per-command sandboxing of tool calls, no container images.
