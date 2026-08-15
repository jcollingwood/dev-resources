---
description: Integrator executes ops task step-by-step → second integrator re-verifies every mutating step from scratch (verify-only) → reviewer only if code/config changed
---
Use the subagent tool with a chain parameter to execute this workflow for: $@

1. Use the "integrator" agent to execute the ops task above ($@) step-by-step, per its own verify-after-each-step discipline.
2. SECOND integrator call in VERIFY-ONLY mode (use the {previous} placeholder; say "verify-only" in its task text): re-check every mutating step FROM SCRATCH — fresh status checks, log tails, health probes. Do not trust or merely re-read the first report's claims. Output pass/fail per action + one evidence line each. If any step fails: stop and present the user with the failure + evidence (do NOT attempt fixes in this chain).
3. Use the "reviewer" agent ({previous}) ONLY if code/config files were changed during the ops task; skip it for pure runtime/infra actions.

Present to the user: what was done per step, the verify-only pass/fail table with its evidence lines, and any reviewer findings if step 3 ran. Never present a failed verification as success — surface failures verbatim.
