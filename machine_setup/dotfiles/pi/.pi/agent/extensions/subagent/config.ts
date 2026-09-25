/**
 * Env/policy constants, parsed once at module load.
 */

import * as fs from "node:fs";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
// Wall-clock cap for a single child `pi` process; overridable via env (SUBAGENT_TIMEOUT_MIN), floor of 1 min.
const _childTimeoutParsed = parseInt(process.env.SUBAGENT_TIMEOUT_MIN ?? "", 10);
export const CHILD_TIMEOUT_MIN = Math.max(1, Number.isFinite(_childTimeoutParsed) ? _childTimeoutParsed : 30);
// Org-level hard ceiling on assistant turns per child; overridable via env (SUBAGENT_MAX_TURNS),
// floor of 0 (= unlimited). A caller's maxTurns param can only tighten this, never loosen it.
const _subagentMaxTurnsParsed = parseInt(process.env.SUBAGENT_MAX_TURNS ?? "", 10);
export const SUBAGENT_MAX_TURNS = Math.max(0, Number.isFinite(_subagentMaxTurnsParsed) ? Math.floor(_subagentMaxTurnsParsed) : 0);
// Nesting-depth policy: a session at depth d may register/spawn subagents iff d < SUBAGENT_MAX_DEPTH.
// Default 1 (top level only); floor 1 so the top level can always spawn. Opt in via PI_SUBAGENT_MAX_DEPTH=2 for one nesting level.
const _subagentMaxDepthParsed = parseInt(process.env.PI_SUBAGENT_MAX_DEPTH ?? "", 10);
export const SUBAGENT_MAX_DEPTH = Math.max(1, Number.isFinite(_subagentMaxDepthParsed) ? _subagentMaxDepthParsed : 1);
// Stored-message cap per child result: bounds how much transcript is embedded in
// persisted details (session JSONL bloat guard). Keep first 3 + last (CAP-3); the
// elided middle count rides on SingleResult.elidedMessages for a drill-in marker.
export const SUBAGENT_STORED_MSG_CAP = (() => {
	const raw = parseInt(process.env.PI_SUBAGENT_STORED_MSGS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? Math.max(raw, 10) : 60;
})();
// Opt-in mechanical delegation nudge: after N completed turns with zero subagent
// delegations in this session, inject a one-line reminder into model context via a
// turn_end custom_message boundary entry (no forced continuation). Default off.
export const NUDGE_ENABLED = process.env.SUBAGENT_NUDGE === "1";
export const NUDGE_TURNS = (() => {
	const raw = parseInt(process.env.SUBAGENT_NUDGE_TURNS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? Math.max(raw, 3) : 8;
})();
// Opt-in RPC child mode: children spawn with --mode rpc and receive their task via stdin
// instead of a positional arg; blocking extension UI dialogs are relayed to this session's
// TUI. Default off — when off, spawn args/stdio/parsing stay byte-identical to print (json)
// mode so existing sessions replay unchanged.
export const RPC_ENABLED = process.env.SUBAGENT_RPC === "1";

// Fail-closed kill switch for parallel mode: off unless explicitly enabled via
// the SUBAGENT_PARALLEL env var or a config.json { "parallel": true } next to this file.
export const PARALLEL_ENABLED = (() => {
	const envVal = process.env.SUBAGENT_PARALLEL?.trim().toLowerCase();
	if (envVal) return ["on", "1", "true", "yes"].includes(envVal); // positive allowlist: empty/garbage stays off
	try {
		const cfgPath = new URL("./config.json", import.meta.url).pathname;
		if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, "utf8")).parallel === true;
	} catch { /* fall through */ }
	return false; // fail closed: parallel off unless explicitly enabled
})();
