---
description: Designer plans → coder implements exactly per plan → reviewer signs off or loops back
---
Use the subagent tool with a chain parameter to execute this workflow for: $@

1. Use the "designer" agent to create the architecture/implementation plan for the request above ($@).
2. Use the "coder" agent to implement EXACTLY per the previous step's output — use the {previous} placeholder so the full designer plan is passed through verbatim without rewording or summarizing it first. Do not paraphrase, reorder, or trim steps before handing them to coder.
3. Use the "reviewer" agent to review the completed work from the previous step (use the {previous} placeholder).

Review loop: if reviewer flags any [BLOCKING] issues, do NOT treat this as a pass. Loop back by running:
   - "designer" again with {previous} carrying BOTH the original plan AND the reviewer's blocking findings, so it can produce a REVISED spec addressing each blocker (call them out explicitly in its own output).
   - then "coder" again with the revised spec ({previous}) to fix only what was flagged.
   - then "reviewer" again on the result.
Repeat this designer→coder→reviewer loop until reviewer reports no blocking issues (NO BLOCKING ISSUES FOUND) before delivering anything final to the user — never ship a review that still has open blockers, even if they seem minor.

When the sign-off is clean, present to the user: the final plan summary (short), what was changed per coder's report, and reviewer's clean verdict plus any non-blocking suggestions listed for later follow-up. Do not hide non-blocking items — show them as an optional list, but make clear they are non-gating.
