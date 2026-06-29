---
name: start-work
description: Initiate a coding feature/task with clarification, planning & test-first implementation.
---

# Start Work

When invoked, this skill turns open-ended requests into a well-scoped, verifiable task:
1. Clarify goal and success criteria (ask questions to resolve ambiguity).
2. Propose a stepwise plan (prefer small, isolated, testable increments). 
3. Implement plan with TDD or test-first preference where applicable.
4. Deliver a concise post-mortem: what changed, assumptions, verification.

## Clarify Goal and Success Criteria

- don't make assumptions
- ask questions until the task is well-defined

## Propose a Stepwise Plan

- break down the task into small, testable increments
- investigate the project structure and files enough to propose a plan
- attempt to identify the exact files and locations that will be modified
- prefer a focused and surgical change to achieve the desired outcome

## Implement Plan with TDD or Test-First Preference

- write tests first, then implement the feature (where applicable)
- ensure that each increment is verifiable and passes all tests before moving to the next step

## Deliver a Concise Post-Mortem

- summarize what changed, the assumptions made, and how the changes were verified

*do not commit anything to version control*

