---
description: Designer plans → plan gate (reviewer plan-review mode for non-trivial plans) → coder implements exactly per plan → reviewer signs off or loops back
---
Use the subagent tool with a chain parameter to execute this workflow for: $@

1. Use the "designer" agent to create the architecture/implementation plan for the request above ($@).
2. Plan gate — you decide, then state your call in one line: if the plan is non-trivial (>2 files or security/trust boundary touched), run the "reviewer" agent in PLAN-REVIEW mode on the plan (say "plan review" in its task text; use {previous}). If it flags [BLOCKING] items, loop back to "designer" with ONLY the blocking findings + the original goal ({previous}) and re-run this gate. Max 2 full cycles, then stop and present the user with remaining blockers + both sides. If the plan is trivial (≤2 files, no security boundary), skip this step and say so in one line.
3. Use the "coder" agent to implement EXACTLY per the previous step's plan — use the {previous} placeholder so the full designer plan is passed through verbatim without rewording or summarizing it first. Do not paraphrase, reorder, or trim steps before handing them to coder.
4. Use the "reviewer" agent to review the completed work from the previous step (use the {previous} placeholder). If it flags [BLOCKING] issues, do NOT treat this as a pass — loop back to "coder" with ONLY the blocking findings ({previous}) and re-run this review. Max 2 full cycles, then stop and present the user with remaining blockers + both sides.

When the sign-off is clean (NO BLOCKING ISSUES FOUND), present to the user: the final plan summary (short), what was changed per coder's report, and reviewer's clean verdict plus any non-blocking suggestions listed for later follow-up. Do not hide non-blocking items — show them as an optional list, but make clear they are non-gating.
