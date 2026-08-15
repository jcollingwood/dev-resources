# Agent roster — routing reference & scaling rules

Routing reference and scaling conventions for humans/future sessions; the live routing table lives in agents.md.

## Roster index

| Agent | Use when | Don't use when |
|---|---|---|
| coder | A well-specified plan exists (from designer) or a multi-file change with no open design questions — executes numbered steps verbatim, stops on ambiguity | Any design decision is needed, scope beyond the plan's steps, or it's a one-line fix (do inline instead) |
| designer | Multi-file feature needing architecture/implementation planning; read-only, outputs analysis + plan document only | Code must be written or modified in any way, or the change is well-specified enough for coder directly |
| reviewer | Sign-off of finished work (default code-review mode) or a plan when task text says "plan review" — two modes selected by task text | Any file modification is needed; strictly read-only and findings-only, never rewrites plans or emits executable patches |
| worker | Explicit fallback: well-scoped mixed read+write tasks that need no design phase and fit no specialist role | A specialist (coder/designer/reviewer/integrator/researcher) fits — prefer the specialist first |
| integrator | Ops/infra: provisioning, IaC, deployment, monitoring, ops troubleshooting with diagnose→verify discipline | Application-code changes or anything outside environment/config/deploy state; an ambiguous target env stops it rather than guessing |
| researcher | External facts / unverified assumptions: library/API docs, current events, prior art — returns distilled cited answers | Facts verifiable by reading this codebase (designer/coder read the repo instead), or when a different toolset is genuinely required (that's a new agent, not a variant) |

## When a new capability is needed
- NEW SPECIALIZED RESEARCHER VARIANTS ARE PROMPT TEMPLATES, NOT AGENTS — e.g. prompts/security-research.md = "researcher, but rubric weighted to CVE/advisory sources, counter-case queries mandatory". A variant that needs different INSTRUCTIONS goes in prompts/; only a genuinely different TOOLSET justifies a new agent file (e.g. an MCP search API).
- Consolidation cap: ~8 agent files max — beyond that, merge by role family so the routing table doesn't degrade as N grows.

## Watch triggers
- Scout agent stays NO unless read-only recon alone exceeds useful context in a repo (>~50 files to map) — then add scout AND its template together.
- Inline-vs-delegate thresholds in agents.md are deliberate guesses, tune one number at a time after real use.
