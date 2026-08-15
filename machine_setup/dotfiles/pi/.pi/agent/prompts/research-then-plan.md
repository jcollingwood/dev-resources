---
description: Researcher answers external-fact questions → designer plans with cited answers as hard constraints - chain stops after the plan (no implementation)
---
Use the subagent tool with a chain parameter to execute this workflow for: $@

1. Use the "researcher" agent to answer the specific external-fact questions the design hinges on — the task text above ($@) lists them; require citations per its own contract, and treat any "unknown"/Low-confidence answer as a legitimate result, not a failure.
2. Use the "designer" agent to create the architecture/implementation plan (use the {previous} placeholder). Its task text must state: researcher's cited answers are HARD inputs — list them under a ## Constraints section verbatim WITH their citations; any "unknown"/Low-confidence answer becomes an explicit Open question in the plan, NEVER filled from memory.

The chain STOPS after the plan is returned for user review: no coder, no reviewer. Present the designer's full plan (with its Constraints and Open questions) to the user, and continue with implementation via prompts/plan-review.md once it is approved. Do not start implementing on your own authority.
