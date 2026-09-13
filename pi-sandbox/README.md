# psb — pi sandbox

One-command wrapper that runs [`pi`](https://github.com/badlogic/pi-mono) in a
[bubblewrap](https://github.com/containers/bubblewrap) sandbox on an isolated
copy of your repo, with the host read-only and secrets masked. No daemon, no
images — it uses the host's own node/npm/git binaries.

## Quickstart

```bash
# In a git repo, just run psb — it defaults to ./
cd ~/code/myproj && psb

# First time creates ~/workspaces/sandbox/myproj from ./
# Second time auto-reuses the existing sandbox

# Explicit repo/path
./psb ./myrepo

# Same, but name the sandbox copy explicitly:
./psb -n myrepo-wip ./myrepo

# Clone + sandbox from a URL:
./psb https://github.com/some/repo.git

# Pass pi args through verbatim:
./psb ./myrepo --prompt "fix the failing test"

# No network egress (also shadows /etc/resolv.conf):
./psb --net none ./myrepo

# Fresh pi state per run instead of your real ~/.pi session history:
./psb --scratch ./myrepo

# See exactly what would run, without running it:
./psb --dry-run ./myrepo
```

By default the repo is copied to `~/workspaces/sandbox/<name>` (name = `-n NAME`
or basename of path/URL; defaults to current directory name if no repo is given)
and bound writable at that same absolute path. If the sandbox already exists,
it is auto-reused — no need for `--reuse`.

## Flags

| Flag | Effect |
|---|---|
| `-n NAME` | Name for the sandboxed copy under `~/workspaces/sandbox/` |
| `--reuse` | Reuse an existing non-empty target dir instead of erroring |
| `--inplace` | Skip copying; bind the given local path writable at its own absolute path. **Writes go to your real repo.** |
| `--net none` | Add `--unshare-net` and shadow `/etc/resolv.conf` with an empty file (otherwise DNS still resolves via systemd-resolved's UDS in shared `/run`) |
| `--scratch` | Bind a fresh per-run tmp dir over `$HOME/.pi` instead of the real one |
| `--mask PATH` | Extra path to mask (repeat the flag for several). Dirs → empty tmpfs, files → `/dev/null`. Missing paths warn and are skipped rather than created on the host. |
| `--dry-run` | Print the full bwrap command, don't exec |
| `-h`, `--help`, `psb help` | Usage text |

Always masked (when present): dirs `~/.ssh ~/.aws ~/.gnupg ~/.config/gh
~/.kube ~/.docker`; files `~/.netrc ~/.npmrc ~/.git-credentials`.

Inside the sandbox: `TMPDIR=/tmp` (a real tmpfs, not a symlink) and
`npm_config_cache=/tmp/npm-cache`, so `npm install` works without touching host
state. Everything else in the environment is inherited.

Unshares: `--unshare-user-try --unshare-pid --unshare-ipc --unshare-uts`
(plus `--unshare-net` with `--net none`). Identity uid mapping is kept, so git
has no "dubious ownership" issues.

## Threat model — what IS protected

- **Writes**: the entire host filesystem is read-only (`--ro-bind / /`) except
  the sandboxed repo copy (or your real repo with `--inplace`), pi's state dir
  (your real `$HOME/.pi`, or a fresh per-run dir with `--scratch` — writable
  either way, just not your history), and `/tmp`. A rogue tool call cannot
  modify system files, other repos, or host config.
- **Secrets**: the masked list above is hidden from the sandbox — an agent
  can't read your SSH keys, cloud creds, or token-bearing dotfiles.
- **Optional network**: `--net none` kills TCP egress and DNS resolution.

## Known limitations (v1)

- The host is otherwise **readable**. Anything not on the mask list (e.g.
  `~/.config`, other dotfiles, source trees with embedded creds) can be read —
  and if network is shared, exfiltrated. The mask list *is* your exfil-by-read
  boundary; extend it via `--mask` as new credential locations appear.
- No domain-level egress control: network is all-or-nothing (shared host net
  vs. fully off). A proxy allowlist would be the v2 fix.
- No seccomp, no per-tool-call sandboxing, no container images.
- `.git/hooks` inside the writable repo copy is not re-RO'd (Codex does); hooks
  only fire from git invocations the agent itself makes, so this is accepted in v1.
- `--inplace` defeats the "original never touched" guarantee by design.

## Testing

```bash
./test-pisbox.sh   # non-interactive smoke test (5 assertions)
```

Hard requirements: bash, coreutils, git, bwrap. Assertions 3 and 4 skip
themselves when node/pi or curl are absent.
