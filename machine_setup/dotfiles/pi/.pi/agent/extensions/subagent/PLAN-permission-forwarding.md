# Plan: Permission Forwarding for Subagents (Option B) — REFINED

## Problem

Subagents spawned by `extensions/subagent/index.ts` run as non-interactive child processes (`pi --mode json -p --no-session`). The permission system's `selectAuthorizer()` dispatches:

1. `hasUI` → LocalUserAuthorizer — **NO** (non-interactive)
2. Subagent detected + parent resolvable → ParentAuthorizer — **NO** (no env vars set)
3. Fallback → **DenyingAuthorizer** ← this is what hits, auto-denying all `ask` policies

## Fix: Set env vars in child process spawn

In `runSingleAgent()` where the child is spawned (~line 335), add an `env` to the spawn options built from a helper:

```ts
function buildChildEnv(parentSessionId: string | undefined): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Never leak our session identity into the child (mirrors what pi core's
    // bash tool does in dist/core/tools/bash.js:121-131): the child runs --no-session.
    delete env.PI_SESSION_ID;
    delete env.PI_SESSION_FILE;
    // Don't let an inherited router var override where asks get forwarded
    // (it is checked BEFORE PI_SUBAGENT_PARENT_SESSION in resolvePermissionForwardingTarget).
    delete env.PI_AGENT_ROUTER_PARENT_SESSION_ID;

    // Parent resolution: if we are ourselves a subagent, PI_SUBAGENT_PARENT_SESSION
    // already points at our interactive ancestor — pass it through so nested
    // grandchildren forward straight to the top-level TUI (the intermediate child
    // has no UI and never polls its own inbox; see ForwardingManager guard).
    const candidate = process.env.PI_SUBAGENT_PARENT_SESSION ?? parentSessionId;
    if (candidate) {
        const trimmed = candidate.trim();
        // Mirror normalizePermissionForwardingSessionId: reject empty / "unknown".
        if (trimmed && trimmed.toLowerCase() !== "unknown") {
            env.PI_IS_SUBAGENT = "1";                          // triggers subagent detection
            env.PI_SUBAGENT_PARENT_SESSION = trimmed;          // tells it where to forward asks
        }
    }
    return env;
}

const proc = spawn(invocation.command, invocation.args, {
    cwd: cwd ?? defaultCwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildChildEnv(),
});
```

## Env vars needed (from `permission-forwarding.ts`) — VERIFIED

**Detection** — any ONE of these makes the child recognized as a subagent (`SUBAGENT_ENV_HINT_KEYS`):
- `PI_IS_SUBAGENT` ← use this one

**Parent resolution** — first match wins (`SUBAGENT_PARENT_SESSION_ENV_CANDIDATES`):
1. `PI_AGENT_ROUTER_PARENT_SESSION_ID`
2. `PI_SUBAGENT_PARENT_SESSION` ← use this one (shared convention)

## Open question: RESOLVED ✅

The parent session ID comes from **`ctx.sessionManager.getSessionId()`** — the tool's `execute(...)` receives a full `ExtensionContext` with `sessionManager: ReadonlySessionManager` (`dist/core/extensions/types.d.ts:219`, `ReadonlySessionManager` includes `getSessionId()`, `dist/core/session-manager.d.ts:140`).

⚠️ Reviewer correction: pi core does **not** set `PI_SESSION_ID` in its own process env (the only writes are into *bash children's* env at `bash.js:128` and the server harness). The earlier "verified live" observation was contaminated by the bash tool's child env. So `process.env.PI_SESSION_ID` is NOT a reliable source — it must be threaded from `ctx.sessionManager.getSessionId()` through to `runSingleAgent()`, which currently has no such parameter (add one; all three call sites at ~553/625/667 have `ctx`).

Additional findings from investigation:
- `PI_SESSION_FILE` is also set by pi and must be stripped from child env — otherwise a `--no-session` child could inherit the parent's session file path (pi core already strips both in its own bash tool, `dist/core/tools/bash.js:121-131`).
- **Nested subagents**: `ForwardingManager` only runs when `hasUI && !isSubagent` (`forwarding-manager.ts:58`). A non-interactive child never polls its own inbox, so a grandchild forwarding to the intermediate child would time out (10 min). Fix: pass through `PI_SUBAGENT_PARENT_SESSION` unchanged when we are ourselves a subagent (the `?? PI_SESSION_ID` ordering above handles this — passthrough wins over our own id).
- If no parent session id is resolvable (e.g. top-level run without a session), set nothing and keep current behavior (DenyingAuthorizer fallback).

## How forwarding works (for reference)

Once both env vars are set:
1. Child hits an `ask` policy → ParentAuthorizer kicks in (`selectAuthorizer`, `authorizer.ts`)
2. Child writes request JSON to `<forwardingRoot>/sessions/<parentSessionId>/requests/`
3. Parent's ForwardingManager polls that directory every 250ms
4. Prompt surfaces in parent TUI (you approve/deny interactively)
5. Response written back, child continues or aborts
6. Timeout: 10 minutes per request

## Files to modify

- `extensions/subagent/index.ts` — add `parentSessionId?: string` param to `runSingleAgent()`, add `buildChildEnv(parentSessionId)` helper, pass `env: buildChildEnv(...)` on the single spawn call (all modes funnel through it), and thread `ctx.sessionManager.getSessionId()` from the three call sites

## Verification — DONE ✅ (2026-08-15)

Implemented and verified end-to-end:
- `tsc --noEmit` clean; unit tests on the real `buildChildEnv()` source: 5/5 pass (interactive parent, nested passthrough, no-id fallback-off, unknown/whitespace rejection, env fallback).
- Live e2e: spawned `pi --mode json -p --no-session` child with `PI_IS_SUBAGENT=1` + `PI_SUBAGENT_PARENT_SESSION=<parent sid>`, task = edit a file (`edit: * = ask`). Child hit the ask in ~12s, wrote request to `<forwardingRoot>/sessions/<parent-sid>/requests/`; parent ForwardingManager consumed it and surfaced the prompt; approval response written → child proceeded, completed the edit, exited cleanly.
- Nested case covered by unit test (passthrough of inherited `PI_SUBAGENT_PARENT_SESSION`); not exercised live.

Note: during e2e the approval was written directly to the responses dir (bypassing the TUI dialog), so a stale prompt may have lingered in the parent TUI — dismiss if seen.
