# Subagent Extension

Delegate tasks to specialized subagents running in isolated `pi` processes. Each child gets its own context window, a role-specific system prompt and tool allowlist, and streams progress back live; the parent receives a distilled final report plus the full transcript (drill-in).

Built around a **single local inference backend**: parallelism is disabled by default because concurrent children only queue on one model and thrash. Everything below assumes sequential delegation.

## How it works

- Each child is spawned as `pi --mode json -p --no-session` with the agent's system prompt; its JSONL stdout stream is parsed line-by-line (`processLine`) for live progress, usage, and structured events.
- Children load all user-scope extensions (including this one), so capabilities like permission forwarding work mid-run. Re-registration of the `subagent` tool in a child is **depth-gated** (see Nesting below).
- The parent's tool result carries the child's final output as text and the full transcript + usage in `details` (rendered on drill-in, persisted to the session for replay).

## Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task. Optional `cwd`, `maxTurns`. |
| Chain | `{ chain: [{agent, task}, …] }` | Sequential; later steps may reference earlier output via the `{previous}` placeholder. Treat a chain as ONE delegated action (plan all steps before dispatching). Per-step `maxTurns` allowed. |
| ~~Parallel~~ | `{ tasks: [...] }` | **Disabled by default** — removed from the schema entirely unless explicitly enabled; a runtime guard rejects it with an error if it ever appears. Code paths are kept for replay of old sessions and possible re-enable. |

## Agent roster (`~/.pi/agent/agents/*.md`)

| Agent | Purpose | Capability tools (frontmatter allowlist) |
|-------|---------|-------------------------------|
| `researcher` | Web research & fact-checking, cited answers | read, grep, find, ls, bash, web_search, fetch_content, get_search_content, source_check |
| `designer` | Architecture / implementation plans from requests | read, grep, find, ls (read-only) |
| `coder` | Executes implementation plans exactly as specified | read, grep, find, ls, edit, write, bash |
| `reviewer` | Quality/security/convention review — read-only | read, grep, find, ls |
| `integrator` | Provisioning, IaC, deployment, monitoring, ops | read, grep, find, ls, edit, write, bash |
| `worker` | Explicit fallback: well-scoped mixed read+write tasks needing no design phase | (all default tools) |

All child agents additionally get `surface_question` and `report_progress` — orchestrator communication channels rather than capabilities. They are listed in every agent's frontmatter allowlist because pi's `--tools` filter applies to extension-registered tools too; without them the protocol tools would be silently stripped from restricted agents.

Project-local agents live in `.pi/agents/*.md` and are only loaded with `agentScope: "project"|"both"` (interactive confirmation by default; `confirmProjectAgents: false` disables). Project agents override same-named user agents.

## Safeguards & limits

| Guardrail | Default | Override | Behavior |
|-----------|---------|----------|----------|
| Parallel kill-switch | **off** (fail-closed) | `SUBAGENT_PARALLEL=1` (+ optional config.json) | `tasks` param removed from schema; runtime guard returns an error if it appears anyway. |
| Per-child wall-clock timeout | 30 min | `SUBAGENT_TIMEOUT_MIN` (floor 1) | SIGTERM → 5 s grace → unconditional SIGKILL; exit code **124**. |
| Turn cap (`maxTurns`) | unlimited per call | caller param and/or `SUBAGENT_MAX_TURNS` env ceiling (floor 0 = unlimited) | Effective limit = min(param, env). Child is killed when it would start turn N+1 (so at most N full turns complete); SIGTERM → SIGKILL; exit code **125**. Use ~5–8 for lookups, ~20–30 for coding. |
| Nesting depth gate | 1 (top level only) | `PI_SUBAGENT_MAX_DEPTH` (floor 1) | A session at depth *d* registers the `subagent` tool iff *d* < max. Children inherit `PI_SUBAGENT_DEPTH = parent+1` via env and cannot self-elevate. Default: top-level orchestrator can delegate; its children cannot re-delegate. Set to 2 for one nesting level (e.g. worker → researcher). |
| Stored-message cap | 60 per child result | `PI_SUBAGENT_STORED_MSGS` (floor 10) | Keep first 3 + last N−3 messages in persisted `details`; elided count shown as dim marker in drill-in. Bounds session JSONL growth from nested transcripts. |
| Per-task output cap | 50 KB | — | Truncates parallel-mode model-visible text content; full results remain in `details`. |
| User abort | — | Esc / Ctrl+C | Kills the child with SIGKILL escalation; result marked aborted. |

Exit codes: `124` = wall-clock timeout, `125` = turn cap hit, other non-zero = child failure (stderr/error surfaced).

**Delegation nudge (opt-in):** with `SUBAGENT_NUDGE=1`, after `SUBAGENT_NUDGE_TURNS` completed turns (default 8) in which no subagent delegation has occurred, the extension injects ONE `custom_message` entry into model context via a `turn_end` boundary result — visible in the TUI and persisted to the session JSONL (replayed once on resume; no forced continuation or extra model call). Any real subagent delegation suppresses it for the rest of the session, and it fires at most once per session.

## Live display

- **Running (compact line):** static glyph + agent name + live counters from the child's stream (`turn N`, tools run) — no animation timers. While a nested call is in flight the line shows a breadcrumb: `→ researcher (task preview): turn K` (from `tool_execution_start/update/end` pass-through; cleared when the nested call ends).
- **Completed:** ✓/✗ + agent + usage stats (`turns ↑in ↓out $cost ctx:model`). Failures show stop reason and error message.
- **Drill-in (expanded view):** full task, formatted tool calls, final output rendered as Markdown. Nested subagent results render as indented subtrees up to 3 levels deep (`NESTED_RENDER_DEPTH_CAP`); deeper calls fall back to a one-line preview + `(truncated)`. Works live and on transcript replay — the top-level session persists the whole nested structure inside `details`.
- **Replay-safe:** all new rendering branches are gated on fields that only exist in live results, so old stored sessions render byte-identically.

## Question protocol (`surface_question`)

Children (any depth ≥ 1) get a `surface_question` tool — top-level sessions never see it. When a child hits a decision it cannot resolve safely:

1. Child calls `surface_question(question, options?)`.
2. The extension records it via `pi.appendEntry("subagent_question", …)` and tells the model to **stop immediately** with a brief summary of where it left off. (Works in print mode + `--no-session`: the entry is kept in memory and emitted on the JSON stream.)
3. Parent parses the `entry_appended` event into `SingleResult.questions[]`.
4. The orchestrator sees a banner in the tool result:

   ```
   ⚠ CHILD HALTED WITH UNRESOLVED QUESTION(S):
   1. "Tabs or spaces?" (options: tabs; spaces)
   To continue: re-invoke <agent> with the answer appended to the task …
   ```

5. Orchestrator answers from context and re-dispatches, or asks the user first (`AGENTS.md` mandates never ignoring it). Chain mode stops cleanly at the halted step (not marked as an error) since later steps would consume a halted summary via `{previous}`.

Cost model: one extra spawn per question — no mid-run injection into print-mode children (stdin is ignored there). Under `SUBAGENT_RPC=1` with a UI-capable parent, the child gets `PI_SUBAGENT_UI_RELAY=1` and `surface_question` becomes **relay-and-continue**: it prompts the parent's TUI via an RPC dialog (`ctx.ui.input`) mid-run and returns the answer to the child ("Answer received: … Continue working.") instead of halting; a cancelled/timeout relay tells the child to proceed with best judgment or stop. Print-mode children keep the halt-based protocol above unchanged; RPC children of headless parents also relay, but the immediately auto-cancelled answer tells them to proceed with best judgment or stop instead of halting. Permission asks still flow child → top-level TUI → human mid-run via pi-permission-system's file inbox (`PI_IS_SUBAGENT` / `PI_SUBAGENT_PARENT_SESSION`) — a separate channel that this protocol does not touch.

## Delegation log

Every delegation is auto-logged by the extension (regardless of model compliance) as JSONL at:

```
~/.local/state/pi-agent/delegations.log
```

Fields per line: `{ts, mode, agents[], taskHash(sha256[:12]), status, durationMs}`. `status` ∈ `ok | error | question`. `agents` is capped at 10 entries (`+N more`). Lines predating the JSONL migration may be in a legacy pipe format — filter with `grep '^{'` before piping to jq if you hit parse errors. Weekly review examples:

```bash
# Delegation rate and per-agent share
jq -r '.agents[]' ~/.local/state/pi-agent/delegations.log | sort | uniq -c | sort -rn

# p50/p95 duration per agent (ms)
jq -r 'select(.status=="ok") | [.agents[0], .durationMs] | @tsv' \
  ~/.local/state/pi-agent/delegations.log | awk '{a[$1]+=$2; c[$1]++} END {for (k in a) print k, a[k]/c[k]}'

# How often children halted on questions (decision input for RPC upgrade)
jq -r 'select(.status=="question") | .ts' ~/.local/state/pi-agent/delegations.log | wc -l
```

## Environment variables

| Variable | Scope | Meaning / default |
|----------|-------|-------------------|
| `SUBAGENT_PARALLEL` | top-level | `"1"` enables parallel mode (fail-closed otherwise). |
| `SUBAGENT_RPC` | all levels | `"1"` spawns children in RPC mode (`--mode rpc`, task delivered via stdin) with blocking dialogs relayed to this session's TUI; default off — print/json behavior is byte-identical when unset. |
| `SUBAGENT_NUDGE` | top-level | `"1"` enables the mechanical delegation nudge; default off. |
| `SUBAGENT_NUDGE_TURNS` | top-level | Completed-turn threshold before nudging. Default 8, floor 3. |
| `SUBAGENT_TIMEOUT_MIN` | all levels | Wall-clock cap per child, minutes. Default 30, floor 1. |
| `SUBAGENT_MAX_TURNS` | all levels | Org-level hard ceiling on assistant turns per child. Default 0 = unlimited; a caller's `maxTurns` can only tighten it. |
| `PI_SUBAGENT_STORED_MSGS` | all levels | Stored-message cap per child result (bloat guard). Default 60, floor 10; keep first 3 + last N−3. |
| `PI_SUBAGENT_MAX_DEPTH` | top-level (propagated) | Max nesting depth. Default 1, floor 1. |
| `PI_SUBAGENT_DEPTH` | internal | Current depth, set by the parent for each child; children cannot override meaningfully (gate reads inherited value). |
| `PI_IS_SUBAGENT` | internal | `"1"` in every child — gates the `surface_question` tool and permission forwarding. |
| `PI_SUBAGENT_UI_RELAY` | internal | `"1"` in RPC children of UI-capable parents (`SUBAGENT_RPC=1` + parent TUI) — child `surface_question` relays through the parent TUI and continues instead of halting. |
| `PI_SUBAGENT_PARENT_SESSION` | internal | Parent session id, used by pi-permission-system to route permission asks back up. |

## Security model

- The tool executes a separate `pi` subprocess with a delegated system prompt and tool allowlist (frontmatter `tools:`). Leaf agents are deliberately read-only or narrowly scoped; only `worker` has full capabilities.
- **Default:** user-level agents only (`~/.pi/agent/agents`). Project-local agents (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to run bash etc. — enable via `agentScope: "both"|"project"` for trusted repos only; interactive confirmation by default.
- Children inherit the parent's environment (`{...process.env}` + depth markers) and cwd (or per-call `cwd`).

## File layout

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (~1530 lines): spawn, stream parsing, display, protocols
├── agents.ts            # Agent discovery (user + project dirs, frontmatter parsing)
└── PLAN-permission-forwarding.md   # Design notes for the permission channel
```

The live agent definitions are in `~/.pi/agent/agents/*.md` (see roster above); the orchestrator's delegation policy lives in `~/.pi/agent/AGENTS.md`.

## Limitations

- Granularity ceiling for live progress is per-turn / per-tool-result, not token-level (JSON `message_update` is delta-only).
- Session bloat: each nesting level embeds the child transcript into result `details`, persisted to the top-level session JSONL — growth per level is now bounded by the stored-message cap (`PI_SUBAGENT_STORED_MSGS`, default 60, floor 10). Tradeoff: very long runs lose middle transcript on replay (final output + usage are unaffected; nested subtrees whose result message was elided fall back to a plain line). Still pairs with keeping `PI_SUBAGENT_MAX_DEPTH` low.
- Print-mode children are one-shot: no mid-run message injection or free-form dialogs (the RPC upgrade is available via `SUBAGENT_RPC=1`).
- RPC mode (`SUBAGENT_RPC=1`): headless parents have no TUI to relay blocking dialogs to — relays auto-cancel immediately so a child never deadlocks on an unanswered request; and there is no heartbeat in RPC mode, so silence from the child means either idle or a blocked (relayed) dialog.
