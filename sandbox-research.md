# Sandboxing the `pi` CLI on Fedora 44 — Research Report

Date: 2026-07 (Fedora 44 Workstation, bwrap 0.12.0, podman 5.8.4, docker 29.7.2, systemd-nspawn/systemd 259)
Target: run `pi` (Node.js TUI at `~/.nvm/versions/node/v24.15.0/bin/pi`, config in `~/.pi`) on an isolated repo copy with minimal friction and strong host protection.

All "verified locally" items below were tested on this machine during research, not just read about.

---

## Recommendation (TL;DR)

**Use bubblewrap (`bwrap`), one wrapper command, no daemon.** It is what both major agent projects use on Linux (OpenAI Codex and Anthropic Claude Code), it starts in milliseconds, uses the host's exact node/npm/git binaries (no image to maintain), and TUI apps work inside it.

**Mount strategy: read-only host + same-path writable binds.**
- `--ro-bind / /` makes everything read-only by default (verified: writes to `/etc` fail with "Read-only file system").
- Re-bind the workspace **at its own absolute path**: `--bind "$REPO" "$REPO"`. Binding to a *new* path fails — bwrap cannot mkdir on the ro root (verified locally; see Pitfalls).
- Hide secrets by masking existing paths: `--tmpfs ~/.ssh`, `--ro-bind /dev/null <file>` for single files. Only mask paths that exist (bwrap would otherwise create an empty file as mountpoint *on the host*).
- `--dev /dev --proc /proc --tmpfs /tmp` — verified on this bwrap version, `--dev` includes `/dev/pts`, `/dev/ptmx`, and `/dev/shm`, so TUIs and node work.

**Suggested wrapper (one command):**

```bash
#!/usr/bin/env bash
# pi-sandbox: run pi in a read-only-host sandbox on $1 (repo copy)
set -euo pipefail
REPO="$(realpath "$1")"
[ -d "$REPO/.git" ] || echo "warning: not a git repo" >&2

bwrap \
  --ro-bind / / \
  --bind "$REPO" "$REPO" \
  --bind "$HOME/.pi" "$HOME/.pi" \          # pi config/sessions (writable)
  $( [ -e "$HOME/.ssh" ] && echo "--tmpfs $HOME/.ssh" ) \
  $( [ -e "$HOME/.aws" ]  && echo "--tmpfs $HOME/.aws" ) \
  $( [ -e "$HOME/.config/gh" ] && echo "--tmpfs $HOME/.config/gh" ) \
  --unshare-user-try --unshare-pid --unshare-ipc --unshare-uts \
  # add for a no-network variant (see Network note):
  # --unshare-net \
  --dev /dev --proc /proc --tmpfs /tmp \
  --cd "$REPO" \
  env npm_config_cache="$TMPDIR/npm-cache" pi "$@"
```

Notes:
- `~/.nvm` stays readable via the ro-bind — node works fine read-only (verified: `node -e ...` and `pi --version` → 0.85.1 both succeed inside bwrap).
- `npm install` into the repo needs a writable cache: point `npm_config_cache` at `$TMPDIR` (the fresh tmpfs `/tmp`) or bind `~/.npm` writable. The repo itself is writable, so installs land in it.
- If you don't want sandbox runs to pollute your real session history, swap the `.pi` bind for a scratch dir: `mkdir -p /tmp/pi-home && --bind /tmp/pi-home "$HOME/.pi"`.

---

## 1. bwrap vs podman/docker vs systemd-nspawn

| | **bwrap** | **podman (rootless)** | **docker** | **systemd-nspawn** |
|---|---|---|---|---|
| Setup friction | One command, no daemon, no image | Needs an image with node+git+tools; repo must be bind-mounted or copied in; `~/.pi`/nvm must be mounted too | Same as podman + a daemon (violates "no daemon") | Needs a full OS rootfs/install; heaviest |
| Startup | Milliseconds | ~100ms–s (image pull first time) | similar | slowest |
| Filesystem semantics | Host fs directly — exact same binaries, no overlay copy cost | overlayfs image + bind mounts; two copies of toolchains possible | same | full guest rootfs |
| Network control | Coarse: share host net (default), `--unshare-net` (no egress), or manual veth/slirp4netns for filtered net | Fine-grained (`--network none`, slirp4netns, port maps) — best-in-class here | fine-grained | full guest networking config |
| TUI compatibility | Verified working (pi --version; /dev/pts + ptmx present via `--dev`) | Works (pty passthrough is standard) | Works | Works |
| Host protection model | Read-only host by default, explicit writable carve-outs — exactly the goal | Container rootfs isolated by default; bind mounts are the hole to manage | same | guest fs isolated |

**Why bwrap wins for this use case:** priority (1) is simplicity/one-command/no-daemon and priority (3) is "pi must still work" — bwrap runs the *host's* node/npm/git verbatim, so there is zero compatibility surface. podman/docker only win on fine-grained network policy; if you later need domain-level egress control, that's a proxy problem (see §3), not a container problem. systemd-nspawn is for full-OS guests — overkill.

Sources:
- Codex uses bwrap as its Linux sandbox backend (prefers system `bwrap`, bundles a fallback binary): https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
- Claude Code's Linux sandbox = bubblewrap + socat proxy, explicitly "no Docker daemon, no containers": https://code.claude.com/docs/en/sandboxing and https://www.anthropic.com/engineering/claude-code-sandboxing
- Comparison of agent isolation tiers (per-command sandbox → devcontainer → VM): https://code.claude.com/docs/en/sandbox-environments

## 2. bwrap invocation best practices ("read-only host + writable workspace")

**`--ro-bind / /` vs explicit bind lists.** Use `--ro-bind / /`. It's what Codex does (https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md) and it inverts the failure mode safely: anything you forget is read-only, not exposed. Explicit allow-lists (`--ro-bind-try /usr /usr ...` à la https://github.com/homebrew/brew/blob/main/Library/Homebrew/extend/os/linux/sandbox.rb or https://github.com/containers/bubblewrap/blob/main/demos/bubblewrap-shell.sh) are more fragile on a distro with everything under `/usr` and give no extra protection for this threat model.

**Hiding sensitive paths.**
- Directories: `--tmpfs ~/.ssh` (mounts an empty tmpfs over it — path exists but is empty). This is what npm-jail does for `.ssh`/`.aws`: https://github.com/suethttps/npm-jail
- Single files: `--ro-bind /dev/null <file>` shadows the file. Edge case from npm-jail: if the deny target *doesn't exist yet*, bwrap creates an empty file as a mountpoint **on the host** — so guard with `[ -e ]` (as in the wrapper above).
- Codex additionally re-applies `--ro-bind` on protected subpaths *inside* writable roots (e.g. `.git/hooks`, git config) so even the workspace can't be used to plant hooks: https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md. Worth adding for pi: `--ro-bind "$REPO/.git/config" ...` is *not* advisable (git needs to write config sometimes); instead consider keeping `.git/hooks` ro or just relying on the fact that hooks only fire from git invocations the agent itself makes.

**/dev, /proc, /tmp.**
- `--dev /dev`: minimal devtmpfs. Verified locally it contains `null zero full random urandom tty ptmx pts shm fd core stdin stdout stderr` — enough for TUIs and node (no separate `/dev/shm` bind needed).
- `--proc /proc`: fresh proc for the new PID namespace; required when using `--unshare-pid`. (Inside an unprivileged *container* this can fail — not our case on bare Fedora.)
- `--tmpfs /tmp`: fresh scratch per run. Set `TMPDIR=/tmp` explicitly and make sure it's a real dir, not a symlink (see Pitfalls).

**Unshare flags when running as the same uid.**
- Verified locally: bwrap works unprivileged on this host *without* `--unshare-user`, and with or without it, `id` inside is still `uid=1000(joel)` — bwrap's default user mapping is identity. So **no git ownership problems arise** (see Pitfalls).
- Recommended set: `--unshare-pid --unshare-ipc --unshare-uts` (hide host processes, isolate IPC/hostname) plus `--unshare-user-try` to match Codex/Homebrew practice and get the NO_NEW_PRIVS/setuid hardening for free. `-try` variants keep it working if a kernel/sysctl ever blocks userns creation.
- Network: see below — this is your main policy knob.

**Network.** Verified locally on this host:
- Default (no net flags): shares host network namespace → DNS and egress work, web search works, but **exfiltration is possible**. This is the usability default; accept it or add a proxy later.
- `--unshare-net`: real TCP egress fails (`fetch` → `ENETUNREACH`, verified) — good for "no exfil" mode. **But DNS still resolves** because `/etc/resolv.conf` points at systemd-resolved's stub (127.0.0.53), which is served over a Unix socket in the shared `/run`. Result: confusing "resolves but can't connect" errors, plus search-domain leakage. If you use `--unshare-net`, also shadow resolv.conf (e.g. `--ro-bind <empty-file> /etc/resolv.conf` — test it) or bind-mount a private `/run`.
- Middle ground (what Claude Code does): keep network shared but route egress through an out-of-sandbox proxy with a domain allowlist: https://code.claude.com/docs/en/sandboxing. More moving parts; skip for v1.

## 3. How other agent-sandboxing projects do it

- **OpenAI Codex CLI (Linux):** bwrap with `--ro-bind / /`, writable roots layered via `--bind <root> <root>`, protected subpaths re-applied read-only, `--unshare-user --unshare-pid`, `--unshare-net` when network-restricted (optionally a TCP→UDS proxy bridge), in-process seccomp filter + `PR_SET_NO_NEW_PRIVS`. Prefers system bwrap ≥ version with `--argv0`, else bundled binary. https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md — third-party walkthrough of seatbelt/bwrap/Landlock across platforms: https://codex.danielvaughan.com/2026-05-03/codex-cli-sandbox-internals-seatbelt-bubblewrap-landlock-windows-dacl/
- **Anthropic Claude Code:** on Linux, bubblewrap + socat; writes confined to cwd + session `$TMPDIR`; host broadly *readable* with opt-in `denyRead` (note: weaker default than our ro-everything approach); network via out-of-sandbox proxy, no domains pre-allowed. Documented pitfalls: Ubuntu 24.04+ AppArmor blocks unprivileged userns (`kernel.apparmor_restrict_unprivileged_userns`) — *not* a Fedora issue; nested-container `/proc` mount failure (escape hatch `sandbox.enableWeakerNestedSandbox`, "considerably weakens security"). https://code.claude.com/docs/en/sandboxing, blog: https://www.anthropic.com/engineering/claude-code-sandboxing
- **Community bwrap-for-agents wrappers** (good flag references): umago/bubblewrap-ai — ro host, whitelisted dotfiles, clean env (`env_allow`), `home_block` precedence: https://github.com/umago/bubblewrap-ai ; didvc/ai-bwrap — rw only in cwd, rest of `$HOME` hidden, passes through only needed config/cache dirs: https://github.com/didvc/ai-bwrap
- **npm lifecycle-script sandboxing:** suethttps/npm-jail — bwrap for `npm install`, `.ssh`/`.aws` hidden via `--tmpfs`, file denies via `--ro-bind /dev/null`: https://github.com/suethttps/npm-jail
- **CI-grade examples:** Homebrew's Linux sandbox (canonical flag set: `--unshare-user --unshare-ipc --unshare-pid --unshare-uts --ro-bind / / --proc /proc --dev /dev`): https://github.com/homebrew/brew/blob/main/Library/Homebrew/extend/os/linux/sandbox.rb ; bubblewrap's own demo shell (separate `/tmp`, `/home`, `/var`, `/run`; inherit resolv.conf; drop `--share-net` to disable networking): https://github.com/containers/bubblewrap/blob/main/demos/bubblewrap-shell.sh

## 4. Pitfalls & mitigations

| # | Pitfall | Detail / evidence | Mitigation |
|---|---|---|---|
| 1 | **Bind to a non-existent destination fails** | `--bind $REPO /workspace` → `bwrap: Can't create file /workspace: Read-only file system` (verified locally — bwrap can't mkdir on the ro root) | Bind at the same absolute path (`--bind "$REPO" "$REPO"`), as Codex does. If you must use a different inner path, build on a tmpfs root first (bubblewrap-shell.sh style). |
| 2 | **Mount order: later actions shadow earlier ones** | `--bind /tmp/ws /tmp/ws ... --tmpfs /tmp` silently hid the workspace; writes failed with ENOENT (verified locally) | Put writable binds *after* `--tmpfs /tmp`. The wrapper above orders them correctly. |
| 3 | **npm needs a writable cache** | Default cache is `~/.npm`; under ro-home, `npm install` fails on cache writes. `/dev/shm` itself is fine — present via `--dev` (verified) | `env npm_config_cache="$TMPDIR/npm-cache"` or bind `~/.npm` writable/tmpfs. Repo dir being writable covers the actual install. |
| 4 | **Symlinked TMPDIR breaks bwrap binds** | Codex issue #14672: when `$TMPDIR` is a symlink, bwrap fails to bind it → `mktemp` fails inside sandbox (https://github.com/openai/codex/issues/14672) | Use a real directory for the tmpfs/bind target; set `TMPDIR=/tmp` explicitly. |
| 5 | **git "dubious ownership"** | Only occurs if uid mapping changes file ownership inside the sandbox (e.g. remapping to root). Verified locally: default bwrap keeps `uid=1000`, so repo files keep their owner and git is happy | Keep identity mapping (default; don't pass custom `--uid 0`). If you ever remap, set `safe.directory=*` via `GIT_CONFIG_GLOBAL` pointing into the sandbox. |
| 6 | **TUI terminal access** | Needs `/dev/pts` + `/dev/ptmx` for apps that open a new pty; stdio fds pass through regardless. Verified: bwrap's `--dev` includes both, and `pi --version` runs inside (0.85.1). Full interactive TUI session not exercised in this research — smoke-test once | Use `--dev /dev` (not a hand-picked dev bind list). If anything misbehaves, check the app isn't hardcoding `/dev/tty` paths outside the sandbox. Minor known quirk: bwrap#744 (`--unshare-pid` can leave shell state odd after exit) — cosmetic. |
| 7 | **DNS still works under `--unshare-net`** | Verified locally: systemd-resolved stub (127.0.0.53 via Unix socket in shared `/run`) resolves names while TCP egress is dead → confusing errors + search-domain leak | For true no-net mode, also shadow `/etc/resolv.conf` or isolate `/run`. Or accept shared net for v1 and add a proxy later (Claude Code model). |
| 8 | **Denying non-existent paths creates host files** | bwrap creates the mountpoint on the host if it doesn't exist (npm-jail notes this) | Guard every mask with `[ -e path ]` as in the wrapper. |
| 9 | **User-namespace availability** | Fine here (`user.max_user_namespaces=247020`, verified working). Ubuntu 24.04+ AppArmor can block it (Claude Code docs) — irrelevant on Fedora, but `-try` flags keep the wrapper portable | Use `--unshare-user-try`. |
| 10 | **ro-bind / hides nothing by default** | Secrets are *readable* under `--ro-bind / /` until masked. Claude Code's default is even weaker (host readable, opt-in deny) — don't copy that default if exfiltration-by-read is your threat | Mask explicitly (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, keychain dirs). Consider a small blocklist in the wrapper; review it when new credential locations appear. |
| 11 | **pi's own state** | pi writes sessions/config to `~/.pi`; under ro-home that breaks or, if you bind it writable, sandbox runs share/mutate your real session history | Bind `~/.pi` writable (simplest) or a per-run scratch dir (cleanest). |

## Source list
- https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md (primary: Codex bwrap construction)
- https://code.claude.com/docs/en/sandboxing (primary: Claude Code Linux sandbox, pitfalls)
- https://www.anthropic.com/engineering/claude-code-sandboxing (Anthropic engineering blog)
- https://code.claude.com/docs/en/sandbox-environments (isolation tier comparison)
- https://github.com/openai/codex/issues/14672 (symlinked TMPDIR bug)
- https://github.com/homebrew/brew/blob/main/Library/Homebrew/extend/os/linux/sandbox.rb (CI flag reference)
- https://github.com/containers/bubblewrap/blob/main/demos/bubblewrap-shell.sh (official demo)
- https://github.com/umago/bubblewrap-ai , https://github.com/didvc/ai-bwrap , https://github.com/suethttps/npm-jail (community agent/npm sandboxing)
- https://codex.danielvaughan.com/2026-05-03/codex-cli-sandbox-internals-seatbelt-bubblewrap-landlock-windows-dacl/ (secondary walkthrough)
