/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports two modes (parallel mode is disabled for local LLM setups):
 *   - Single: { agent: "name", task: "..." }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
// Expanded view renders nested subagent results as indented subtrees up to this many
// levels deep; calls beyond the cap fall back to a one-line preview + "(truncated)" marker.
const NESTED_RENDER_DEPTH_CAP = 3;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
// Wall-clock cap for a single child `pi` process; overridable via env (SUBAGENT_TIMEOUT_MIN), floor of 1 min.
const _childTimeoutParsed = parseInt(process.env.SUBAGENT_TIMEOUT_MIN ?? "", 10);
const CHILD_TIMEOUT_MIN = Math.max(1, Number.isFinite(_childTimeoutParsed) ? _childTimeoutParsed : 30);
// Org-level hard ceiling on assistant turns per child; overridable via env (SUBAGENT_MAX_TURNS),
// floor of 0 (= unlimited). A caller's maxTurns param can only tighten this, never loosen it.
const _subagentMaxTurnsParsed = parseInt(process.env.SUBAGENT_MAX_TURNS ?? "", 10);
const SUBAGENT_MAX_TURNS = Math.max(0, Number.isFinite(_subagentMaxTurnsParsed) ? Math.floor(_subagentMaxTurnsParsed) : 0);
// Nesting-depth policy: a session at depth d may register/spawn subagents iff d < SUBAGENT_MAX_DEPTH.
// Default 1 (top level only); floor 1 so the top level can always spawn. Opt in via PI_SUBAGENT_MAX_DEPTH=2 for one nesting level.
const _subagentMaxDepthParsed = parseInt(process.env.PI_SUBAGENT_MAX_DEPTH ?? "", 10);
const SUBAGENT_MAX_DEPTH = Math.max(1, Number.isFinite(_subagentMaxDepthParsed) ? _subagentMaxDepthParsed : 1);
// Stored-message cap per child result: bounds how much transcript is embedded in
// persisted details (session JSONL bloat guard). Keep first 3 + last (CAP-3); the
// elided middle count rides on SingleResult.elidedMessages for a drill-in marker.
const SUBAGENT_STORED_MSG_CAP = (() => {
	const raw = parseInt(process.env.PI_SUBAGENT_STORED_MSGS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? Math.max(raw, 10) : 60;
})();
// Opt-in mechanical delegation nudge: after N completed turns with zero subagent
// delegations in this session, inject a one-line reminder into model context via a
// turn_end custom_message boundary entry (no forced continuation). Default off.
const NUDGE_ENABLED = process.env.SUBAGENT_NUDGE === "1";
const NUDGE_TURNS = (() => {
	const raw = parseInt(process.env.SUBAGENT_NUDGE_TURNS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? Math.max(raw, 3) : 8;
})();
// Opt-in RPC child mode: children spawn with --mode rpc and receive their task via stdin
// instead of a positional arg; blocking extension UI dialogs are relayed to this session's
// TUI. Default off — when off, spawn args/stdio/parsing stay byte-identical to print (json)
// mode so existing sessions replay unchanged.
const RPC_ENABLED = process.env.SUBAGENT_RPC === "1";
// Watchdog for a single relayed blocking dialog: if the parent UI never resolves within
// this window we answer cancelled/false so the child can't deadlock on an unanswered request.
const UI_RELAY_TIMEOUT_MS = 120_000;

// Fail-closed kill switch for parallel mode: off unless explicitly enabled via
// the SUBAGENT_PARALLEL env var or a config.json { "parallel": true } next to this file.
const PARALLEL_ENABLED = (() => {
	const envVal = process.env.SUBAGENT_PARALLEL?.trim().toLowerCase();
	if (envVal) return ["on", "1", "true", "yes"].includes(envVal); // positive allowlist: empty/garbage stays off
	try {
		const cfgPath = new URL("./config.json", import.meta.url).pathname;
		if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, "utf8")).parallel === true;
	} catch { /* fall through */ }
	return false; // fail closed: parallel off unless explicitly enabled
})();

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "subagent": {
			const agent = (args.agent as string) || "?";
			const taskText = String(args.task ?? "").replace(/\s+/g, " ").trim();
			const preview = Array.from(taskText).length > 60 ? `${Array.from(taskText).slice(0, 60).join("")}...` : taskText;
			return (
				themeFg("muted", "→ subagent ") +
				themeFg("accent", agent) +
				(preview ? themeFg("dim", `: ${preview}`) : "")
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	// Live progress, populated while the child process is running (rendered as a
	// compact line; ignored by the completed rendering paths):
	turns?: number;
	toolsRun?: number;
	nested?: { agent: string; task: string; turns: number };
	running?: boolean;
	// Unresolved questions surfaced by the child via surface_question (halt protocol):
	questions?: { question: string; options?: string[] }[];
	// Live milestone progress reported by the child via report_progress (latest + ring buffer).
	// Persisted in details like other result fields — small by design (≤10 short entries).
	progress?: { step: string; detail?: string };
	progressLog?: { step: string; detail?: string }[];
	// Set when stored messages were capped at serialization time (see SUBAGENT_STORED_MSG_CAP).
	elidedMessages?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Cap stored messages: keep first 3 + last (cap-3) when over cap. Pure; returns a new array or the original. `cap` must be ≥ 0 (env path is floored at 10). */
export function capStoredMessages(messages: Message[], cap: number = SUBAGENT_STORED_MSG_CAP): { messages: Message[]; elided: number } {
	if (messages.length <= cap) return { messages, elided: 0 };
	const keepFirst = Math.min(3, cap);
	return { messages: [...messages.slice(0, keepFirst), ...messages.slice(messages.length - (cap - keepFirst))], elided: messages.length - cap };
}

/** Pure nudge decision: fire only when threshold reached, no delegation happened, and not already nudged. */
export function shouldNudge(turns: number, delegated: boolean, alreadyNudged: boolean, threshold: number = NUDGE_TURNS): boolean {
	return turns >= threshold && !delegated && !alreadyNudged;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Numbered question list shared by the single-mode banner and the chain-stop message. */
function formatQuestionList(questions: { question: string; options?: string[] }[]): string {
	return questions
		.map((q, i) => {
			const opts = q.options && q.options.length > 0 ? ` (options: ${q.options.join("; ")})` : "";
			return `${i + 1}. "${q.question}"${opts}`;
		})
		.join("\n");
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any>; id?: string };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
						id: typeof part.id === "string" ? part.id : undefined,
					});
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Build the environment for a spawned subagent child so the permission system
 * can forward `ask` prompts back to this session's TUI instead of auto-denying.
 *
 * - Strips our own session identity (mirrors pi core's bash tool): the child
 *   runs --no-session and must not inherit our session file/id.
 * - Sets PI_IS_SUBAGENT so the child is detected as a subagent, and
 *   PI_SUBAGENT_PARENT_SESSION telling it which session to forward asks to.
 * - Sets PI_SUBAGENT_UI_RELAY=1 whenever RPC children are enabled — even a headless parent
 *   answers requests (auto-cancel) so the child proceeds with best judgment instead of
 *   halting. Switches the child's surface_question from halt-based to relay-and-continue.
 * - If we are ourselves a subagent, PI_SUBAGENT_PARENT_SESSION already points at
 *   our interactive ancestor — pass it through unchanged so nested grandchildren
 *   reach the top-level TUI (an intermediate child has no UI and never polls its
 *   own inbox).
 */
function buildChildEnv(parentSessionId: string | undefined, uiRelayEnabled?: boolean): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	// Checked before PI_SUBAGENT_PARENT_SESSION in the child; don't let an
	// inherited router var redirect forwarding.
	delete env.PI_AGENT_ROUTER_PARENT_SESSION_ID;
	// Always reset — an inherited value from a grandparent must not leak into this child's mode choice.
	delete env.PI_SUBAGENT_UI_RELAY;

	// Depth propagation: children inherit their depth from us (+1); they can't
	// self-elevate because they only ever see their own inherited value.
	const _childDepthParsed = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "", 10);
	const childDepth = Number.isFinite(_childDepthParsed) ? Math.max(0, _childDepthParsed) : 0;
	env.PI_SUBAGENT_DEPTH = String(childDepth + 1);

	// Passthrough (nested) > our own session id > env fallback (unreliable: pi
	// core does not set PI_SESSION_ID in its own process, but honor it if present).
	const candidate =
		process.env.PI_SUBAGENT_PARENT_SESSION ?? parentSessionId ?? process.env.PI_SESSION_ID;
	const trimmed = (candidate ?? "").trim();
	// Mirror normalizePermissionForwardingSessionId: reject empty / "unknown".
	if (trimmed && trimmed.toLowerCase() !== "unknown") {
		env.PI_IS_SUBAGENT = "1";
		env.PI_SUBAGENT_PARENT_SESSION = trimmed;
	} else {
		// No valid target — drop any stale inherited value so the child can't
		// pick up a misleading forwarding destination.
		delete env.PI_SUBAGENT_PARENT_SESSION;
	}
	if (uiRelayEnabled) env.PI_SUBAGENT_UI_RELAY = "1";
	return env;
}

/**
 * Append-only delegation log (~/.local/state/pi-agent/delegations.log). Best-effort:
 * any failure here is swallowed so logging can never break the tool call.
 */
function logDelegation(
	mode: "single" | "chain" | "parallel",
	agents: string[],
	taskText: string,
	status: "ok" | "error" | "question",
	durationMs: number,
): void {
	try {
		const dir = path.join(os.homedir(), ".local", "state", "pi-agent");
		fs.mkdirSync(dir, { recursive: true });
		// Cap the agents array so a very long chain can't bloat the log line.
		const loggedAgents =
			agents.length > 10 ? [...agents.slice(0, 10), `+${agents.length - 10} more`] : agents;
		const line = JSON.stringify({
			ts: Date.now(),
			mode,
			agents: loggedAgents,
			taskHash: createHash("sha256").update(taskText).digest("hex").slice(0, 12),
			status,
			durationMs,
		});
		fs.appendFileSync(path.join(dir, "delegations.log"), line + "\n");
	} catch {
		/* logging must never break the tool call */
	}
}

// Minimal structural type for the parent's UI surface used by RPC dialog relay.
type ParentUI = {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
};

/**
 * Build the extension_ui_response record written back to an RPC child's stdin for a relayed
 * blocking dialog. Pure and exported so ad-hoc harness checks can exercise every branch
 * without a live process (no permanent test file lives in this dir). `answer` is the parent
 * UI result (string for select/input/editor, boolean for confirm); undefined/null means
 * timeout or cancel → cancelled:true (or confirmed:false for confirm).
 */
export function buildUIResponse(
	method: "select" | "confirm" | "input" | "editor",
	id: string,
	answer: string | boolean | null | undefined,
): Record<string, unknown> {
	if (method === "confirm") return { type: "extension_ui_response", id, confirmed: answer === true };
	return typeof answer === "string"
		? { type: "extension_ui_response", id, value: answer }
		: { type: "extension_ui_response", id, cancelled: true };
}

/** Race a promise against a watchdog timer; resolves undefined on timeout or rejection. */
function raceWithTimeout<T>(p: Promise<T>, ms: number, timers?: Set<NodeJS.Timeout>): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (timers) timers.delete(timer); // don't leave a dead ref in the set until finish()
			resolve(undefined);
		}, ms);
		if (timers) timers.add(timer);
		p.then(
			(v) => {
				clearTimeout(timer);
				if (timers) timers.delete(timer);
				resolve(v);
			},
			() => {
				clearTimeout(timer);
				if (timers) timers.delete(timer);
				resolve(undefined);
			},
		);
	});
}

/** Map a blocking extension_ui_request method onto the parent's own ctx.ui call. */
function callParentUI(ui: ParentUI, method: string, payload: any): Promise<string | boolean> {
	const title = typeof payload?.title === "string" ? payload.title : "";
	switch (method) {
		case "select":
			return ui.select(
				title,
				Array.isArray(payload.options)
					? payload.options.filter((o: unknown): o is string => typeof o === "string")
					: [],
			);
		case "confirm":
			return ui.confirm(title, typeof payload?.message === "string" ? payload.message : "");
		case "input":
			return ui.input(title, typeof payload?.placeholder === "string" ? payload.placeholder : undefined);
		case "editor":
			return ui.editor(title, typeof payload?.prefill === "string" ? payload.prefill : "");
		default:
			return Promise.resolve(false);
	}
}

/**
 * Apply one parsed JSON stream event from a child `pi --mode json` process to the
 * in-flight result. Returns true when the event was consumed (caller should emit an
 * update). All accesses are guarded: malformed events must never throw out of the
 * stdout handler.
 */
export function applyStreamEvent(result: SingleResult, event: any): boolean {
	if (!event || typeof event !== "object") return false;

	// Grandchild turn count rides in AgentToolResult<SubagentDetails>.details.results[0].usage.turns.
	const readNestedTurns = (value: any): number | undefined => {
		try {
			const t = value?.details?.results?.[0]?.usage?.turns;
			return typeof t === "number" && Number.isFinite(t) ? t : undefined;
		} catch {
			return undefined;
		}
	};

	if (event.type === "message_end" && event.message) {
		const msg = event.message as Message;
		result.messages.push(msg);

		if (msg.role === "assistant") {
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				// Guard against malformed events: a non-numeric field must not poison
				// the accumulators with NaN for every later render.
				const num = (v: unknown): number =>
					typeof v === "number" && Number.isFinite(v) ? v : 0;
				result.usage.input += num(usage.input);
				result.usage.output += num(usage.output);
				result.usage.cacheRead += num(usage.cacheRead);
				result.usage.cacheWrite += num(usage.cacheWrite);
				result.usage.cost += num(usage.cost?.total);
				result.usage.contextTokens = num(usage.totalTokens);
			}
			if (!result.model && msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
		}
		return true;
	}

	if (event.type === "turn_start") {
		try {
			const idx = Number(event.turnIndex);
			result.turns = Number.isFinite(idx) ? idx + 1 : (result.turns ?? 0) + 1;
		} catch { /* malformed turnIndex — keep prior count */ }
		return true;
	}

	if (event.type === "tool_execution_start") {
		try {
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			if (toolName === "subagent") {
				// The child is delegating further: track the grandchild as a breadcrumb.
				const args = event.args && typeof event.args === "object" ? event.args : {};
				result.nested = {
					agent: typeof args.agent === "string" ? args.agent : "?",
					task: typeof args.task === "string" ? args.task.slice(0, 80) : "",
					turns: 0,
				};
			} else if (toolName !== "") {
				// Nested "subagent" calls are tracked separately as breadcrumbs, not counted here.
				result.toolsRun = (result.toolsRun ?? 0) + 1;
			}
		} catch { /* malformed event — ignore */ }
		return true;
	}

	if (event.type === "tool_execution_update" && event.toolName === "subagent") {
		const t = readNestedTurns(event.partialResult);
		if (result.nested && t !== undefined) result.nested.turns = t;
		return true;
	}

	if (event.type === "tool_execution_end" && event.toolName === "subagent") {
		const t = readNestedTurns(event.result);
		if (result.nested && t !== undefined) result.nested.turns = t;
		result.nested = undefined; // breadcrumb resolves when the nested call finishes
		return true;
	}

	// Halt protocol: a child called surface_question, which appends a custom session entry.
	if (
		event.type === "entry_appended" &&
		event.entry?.type === "custom" &&
		event.entry.customType === "subagent_question"
	) {
		try {
			const data = event.entry.data;
			if (data && typeof data.question === "string" && data.question.length > 0) {
				const options = Array.isArray(data.options)
					? data.options.filter((o: unknown): o is string => typeof o === "string")
					: undefined;
				// options may be undefined — downstream readers guard with `q.options && q.options.length`
				result.questions ??= [];
				result.questions.push({ question: data.question, options });
			}
		} catch { /* malformed entry — ignore */ }
		return true;
	}

	// Progress protocol: a child called report_progress → custom session entry on the stream.
	if (
		event.type === "entry_appended" &&
		event.entry?.type === "custom" &&
		event.entry.customType === "subagent_progress"
	) {
		try {
			const data = event.entry.data;
			if (data && typeof data.step === "string" && data.step.trim().length > 0) {
				const step = data.step.trim();
				const detail = typeof data.detail === "string" && data.detail.trim() ? data.detail : undefined;
				result.progress = { step, detail };
				result.progressLog ??= [];
				result.progressLog.push({ step, detail });
				if (result.progressLog.length > 10) result.progressLog.shift(); // ring buffer cap
			}
		} catch { /* malformed entry — ignore */ }
		return true;
	}

	return false;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// Effective turn cap = min of the set values among {caller param, SUBAGENT_MAX_TURNS env};
// neither set → undefined (unlimited). The caller can only tighten the org ceiling.
function resolveMaxTurns(param: number | undefined): number | undefined {
	const candidates = [param, SUBAGENT_MAX_TURNS].filter(
		(v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
	);
	return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	maxTurns: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	parentSessionId?: string,
	uiRelay?: ParentUI, // parent ctx.ui when RPC_ENABLED && ctx.hasUI; undefined → headless (relays auto-cancel)
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// RPC mode: no -p, no positional task arg — the task goes via stdin as a prompt command.
	const args: string[] = RPC_ENABLED ? ["--mode", "rpc", "--no-session"] : ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		running: true,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		if (!RPC_ENABLED) args.push(`Task: ${task}`); // RPC children receive the task via stdin instead
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: RPC_ENABLED ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
				env: buildChildEnv(parentSessionId, RPC_ENABLED), // env set on RPC alone: headless parents still auto-cancel relays
			});
			if (RPC_ENABLED) {
				// First stdin command after spawn; stdout is read from spawn time so no event can be missed.
				proc.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: `Task: ${task}` }) + "\n");
				// EPIPE (a relay write after the child died) arrives as an async 'error' event; unhandled it
				// would throw out of the EventEmitter and take down the parent. Relay writes are best-effort.
				proc.stdin.on("error", () => {});
			}
			let buffer = "";
			let settled = false;
			let timedOut = false;
			let turnCapped = false;
			let killTimer: NodeJS.Timeout | undefined;
			const pendingRelays = new Set<NodeJS.Timeout>(); // watchdogs for in-flight dialog relays

			// Wall-clock timeout: SIGTERM, wait up to 5s for exit, then SIGKILL.
			const timeoutTimer = setTimeout(() => {
				if (turnCapped) return; // cap already fired — its kill path owns the escalation
				timedOut = true;
				currentResult.exitCode = 124;
				currentResult.errorMessage = `timed out after ${CHILD_TIMEOUT_MIN}m`;
				emitUpdate(); // reflect the failure so the TUI doesn't spin forever
				proc.kill("SIGTERM");
				// Unconditional: proc.killed is true after the SIGTERM call above even if
				// the child ignored it, so gating on it would skip the escalation. kill() on an
				// already-exited process is a harmless no-op.
				if (killTimer) clearTimeout(killTimer); // never leave a stale SIGKILL timer pending
				killTimer = setTimeout(() => {
					proc.kill("SIGKILL");
				}, 5000);
			}, CHILD_TIMEOUT_MIN * 60_000);

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer); // never let the timer fire late
				if (killTimer) clearTimeout(killTimer);
				for (const t of pendingRelays) clearTimeout(t); // no relay may outlive the child
				pendingRelays.clear();
				proc.stdout.removeAllListeners();
				proc.stderr.removeAllListeners();
				try { proc.stdin?.destroy(); } catch { /* already gone */ } // our write end must not delay 'close' after a kill
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (RPC_ENABLED) {
					// RPC-only record types (never emitted in json/print mode).
					if (event.type === "response") {
						// We only ever send the prompt command; a failed response carries error text.
						// Tolerate id-less parse-error responses (command:"parse").
						if (event.success === false && typeof event.error === "string" && event.error) {
							const cmd = typeof event.command === "string" ? event.command : "response";
							currentResult.stderr += `${currentResult.stderr ? "\n" : ""}rpc ${cmd} failed: ${event.error}\n`;
						}
						return;
					}
					if (event.type === "extension_ui_request") {
						const method = typeof event.method === "string" ? event.method : "";
						const blocking =
							method === "select" || method === "confirm" || method === "input" || method === "editor";
						if (!blocking) return; // fire-and-forget (notify/setStatus/…) — ignore without responding
						const id = typeof event.id === "string" ? event.id : "";
						// Relay to the parent UI raced against a watchdog; headless parents (no uiRelay)
						// answer immediately so the child never deadlocks on an unanswered request.
						void (async () => {
							const answer = uiRelay
								? await raceWithTimeout(callParentUI(uiRelay, method, event), UI_RELAY_TIMEOUT_MS, pendingRelays)
								: null;
							try {
								proc.stdin.write(
									JSON.stringify(buildUIResponse(method as "select" | "confirm" | "input" | "editor", id, answer)) +
										"\n",
								);
							} catch { /* child stdin already closed — nothing to relay */ }
						})();
						return;
					}
					if (event.type === "extension_error") {
						const ext = typeof event.extensionPath === "string" ? event.extensionPath : "?";
						const err = typeof event.error === "string" && event.error ? event.error : "(no message)";
						currentResult.stderr += `${currentResult.stderr ? "\n" : ""}extension error (${ext}): ${err}\n`;
						return; // never throw out of the stdout handler
					}
					if (event.type === "agent_settled") {
						// Child is done: close stdin and let the existing 'close' handler own finish().
						try { proc.stdin.end(); } catch { /* already closed */ }
						return;
					}
				}
				if (applyStreamEvent(currentResult, event)) emitUpdate();
				// Turn cap: kill when turn N+1 starts so the child completes exactly N full turns.
				// The turnCapped flag guards against re-firing on buffered events after the kill.
				if (!turnCapped && maxTurns && currentResult.turns > maxTurns) {
					turnCapped = true;
					currentResult.exitCode = 125;
					currentResult.errorMessage = `stopped at ${maxTurns} turns (maxTurns)`;
					emitUpdate(); // reflect the failure so the TUI doesn't spin forever
					proc.kill("SIGTERM");
					// Unconditional: same rationale as the timeout path above — proc.killed is true
					// after SIGTERM even if the child ignored it, so gating on it would skip the
					// escalation. Reuses killTimer so finish() clears it.
					if (killTimer) clearTimeout(killTimer); // never leave a stale SIGKILL timer pending
					killTimer = setTimeout(() => {
						proc.kill("SIGKILL");
					}, 5000);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				// A signal-killed child reports code === null (timeout, OOM killer, stray
				// kill); any of those must never look like a clean exit.
				finish(turnCapped ? 125 : timedOut ? 124 : code ?? 1);
			});

			proc.on("error", () => {
				finish(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					// Unconditional escalation — same rationale as the timeout path above:
					// proc.killed is true after SIGTERM even if the child ignored it, so
					// gating on it would hang forever. Reuses killTimer so finish() clears it.
					if (killTimer) clearTimeout(killTimer); // never leave a stale SIGKILL timer pending
					killTimer = setTimeout(() => {
						proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.running = false; // child exited — completed rendering takes over
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const MAX_TURNS_DESCRIPTION =
	"Maximum assistant turns the child may complete (an env ceiling may apply). The child is killed when it would start turn N+1, so it completes at most N full turns. Use ~5-8 for researcher-style lookups, ~20-30 for coding tasks.";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	maxTurns: Type.Optional(Type.Number({ minimum: 1, description: MAX_TURNS_DESCRIPTION })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	maxTurns: Type.Optional(Type.Number({ minimum: 1, description: MAX_TURNS_DESCRIPTION })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	...(PARALLEL_ENABLED
		? {
				tasks: Type.Optional(
					Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" }),
				),
			}
		: {}),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	maxTurns: Type.Optional(Type.Number({ minimum: 1, description: MAX_TURNS_DESCRIPTION })),
});

export default function (pi: ExtensionAPI) {
	// Build the "Available agents:" line from live user-scope discovery so it
	// tracks the actual roster; fall back to a static list if discovery finds nothing or throws.
	let discoveredAgents: { name: string; description: string }[] = [];
	try {
		discoveredAgents = discoverAgents(process.cwd(), "user").agents;
	} catch { /* malformed agent file — use the static fallback below */ }
	const agentListLine =
		discoveredAgents.length > 0
			? `Available agents: ${discoveredAgents.map((a) => `${a.name} (${a.description.replace(/\s+/g, " ").trim()})`).join("; ")}.`
			: "Available agents: researcher (web research/fact-checking, cited answers), designer (designs/specs), coder (implements plans), reviewer (code or plan review), integrator (ops/infra/deploy), worker (general mixed read+write fallback).";

	const description = [
		"Delegate a task to a specialized subagent (isolated context; returns a distilled report).",
		agentListLine,
		"Delegate by default for: external facts or unverified assumptions; changes touching >2 files or ~100+ lines; work requiring reading many files; security-sensitive code; long-running ops. Inline only for trivial single-file edits.",
		PARALLEL_ENABLED
			? "Modes: single (agent + task) for one agent; chain ([{agent,task}]) when a later step consumes an earlier output ({previous} placeholder) — e.g. chain coder then reviewer in ONE call; parallel (tasks[]) to run multiple agents concurrently."
			: "Modes: single (agent + task) for one agent; chain ([{agent,task}]) when a later step consumes an earlier output ({previous} placeholder) — e.g. chain coder then reviewer in ONE call. Parallel mode is disabled (single local inference backend): run one agent per call.",
		"maxTurns caps a child's assistant turns (killed when it would start turn N+1, so at most N full turns complete); set ~5-8 for lookups, ~20-30 for coding tasks.",
	].join(" ");

	const _currentDepthParsed = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "", 10);
	const currentDepth = Number.isFinite(_currentDepthParsed) ? Math.max(0, _currentDepthParsed) : 0;
	// Nesting gate: skip registration entirely when depth >= SUBAGENT_MAX_DEPTH so the model never sees the tool.
	if (currentDepth >= SUBAGENT_MAX_DEPTH) return;

	// Delegation-nudge state (only consulted by the handlers below, which are registered iff NUDGE_ENABLED).
	let nudgeTurns = 0;
	let nudged = false;
	let delegatedThisSession = false;
	if (NUDGE_ENABLED) {
		pi.on("session_start", (_e, ctx) => {
			nudgeTurns = 0; // intentionally fresh on resume (conservative: needs N new completed turns)
			nudged = false;
			delegatedThisSession = false;
			// Seed from the resumed branch: a prior subagent delegation or nudge entry suppresses re-firing.
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "subagent") {
					delegatedThisSession = true;
				} else if (entry.type === "custom_message" && entry.customType === "subagent-nudge") {
					nudged = true;
				}
			}
		});
		pi.on("turn_end", (ev) => {
			if (ev.outcome !== "completed") return undefined;
			nudgeTurns++;
			if (!shouldNudge(nudgeTurns, delegatedThisSession, nudged)) return undefined;
			nudged = true;
			return {
				// Append to entries accumulated by earlier handlers (runner merge is last-wins per field).
				entries: [
					...(ev.entries ?? []),
					{
						type: "custom_message",
						customType: "subagent-nudge",
						content: `Automated reminder (not from the user): ${nudgeTurns} turns of inline work with no subagent delegation. If remaining work is independent and self-contained, consider delegating it via the subagent tool.`,
						display: true,
					},
				],
			};
		});
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const execStart = Date.now();
			// Hash covers ALL step/task texts joined with \n, so chain/parallel calls
			// get one stable identifier per distinct delegation.
			const taskText = (params.chain ?? [])
				.map((s) => s.task)
				.concat((params.tasks ?? []).map((t) => t.task))
				.concat(params.task ? [params.task] : [])
				.join("\n");
			// Session id of this (possibly nested) session; used to forward the
			// child's permission asks back here. buildChildEnv prefers an inherited
			// PI_SUBAGENT_PARENT_SESSION when we are ourselves a subagent.
			const parentSessionId = ctx.sessionManager.getSessionId();
			// RPC dialog relay: only when RPC children are enabled AND this session has a TUI;
			// headless (-p) parents pass undefined → relays auto-cancel so children never block.
			const uiRelay = RPC_ENABLED && ctx.hasUI ? ctx.ui : undefined;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results: results.map((r) => {
						const capped = capStoredMessages(r.messages);
						return capped.elided > 0 ? { ...r, messages: capped.messages, elidedMessages: capped.elided } : r;
					}),
				});

			// Defense-in-depth: unreachable when the registration gate works, but protects against env tampering or stale registrations.
			if (currentDepth >= SUBAGENT_MAX_DEPTH) {
				return {
					content: [
						{
							type: "text",
							text: `Subagent nesting limit reached (PI_SUBAGENT_MAX_DEPTH=${SUBAGENT_MAX_DEPTH}); do not retry.`,
						},
					],
					details: makeDetails("single")([]), // same shape as the parallel-disabled guard below
					isError: true,
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (hasTasks && !PARALLEL_ENABLED) {
				return {
					content: [
						{
							type: "text",
							text: `Parallel mode is globally disabled in this environment. Do NOT retry with tasks[]. Run each agent as its own single-mode call ({agent, task}), one at a time; use chain only when a later step needs an earlier step's output via {previous}.`,
						},
					],
					details: makeDetails("single")([]), // render via the exercised single branch, not an empty parallel detail
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// Parameter/permission guards are above; agent existence is validated here because runSingleAgent resolves agents internally — an unknown-agent call never spawns a process and must not suppress the nudge.
			const requestedNames = new Set<string>();
			if (params.chain) for (const step of params.chain) requestedNames.add(step.agent);
			if (params.tasks) for (const t of params.tasks) requestedNames.add(t.agent);
			if (params.agent) requestedNames.add(params.agent);
			if ([...requestedNames].every((name) => agents.some((a) => a.name === name))) {
				delegatedThisSession = true;
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						resolveMaxTurns(step.maxTurns),
						signal,
						chainUpdate,
						makeDetails("chain"),
						parentSessionId,
						uiRelay,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						logDelegation("chain", results.map((r) => r.agent), taskText, "error", Date.now() - execStart);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}

					// Halt protocol: the child exited cleanly but is awaiting an answer — stop the chain
					// without marking it as an error.
					if ((result.questions?.length ?? 0) > 0) {
						logDelegation("chain", results.map((r) => r.agent), taskText, "question", Date.now() - execStart);
						return {
							content: [
								{
									type: "text",
									text: [
										`Chain stopped at step ${i + 1} (${step.agent}): awaiting answer to:`,
										formatQuestionList(result.questions!),
										`To continue: re-invoke the chain (or ${step.agent}) with the answer appended to the task (e.g. "Answer to your question '...' is ... — continue"). If you can't decide, ask the user first.`,
									].join("\n"),
								},
							],
							details: makeDetails("chain")(results),
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				logDelegation("chain", results.map((r) => r.agent), taskText, "ok", Date.now() - execStart);
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						resolveMaxTurns(t.maxTurns),
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						parentSessionId,
						uiRelay,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				logDelegation(
					"parallel",
					params.tasks.map((t) => t.agent),
					taskText,
					results.some(isFailedResult) ? "error" : "ok",
					Date.now() - execStart,
				);
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					resolveMaxTurns(params.maxTurns),
					signal,
					onUpdate,
					makeDetails("single"),
					parentSessionId,
					uiRelay,
				);
				const isError = isFailedResult(result);
				const hasQuestions = (result.questions?.length ?? 0) > 0;
				logDelegation(
					"single",
					[params.agent],
					taskText,
					isError ? "error" : hasQuestions ? "question" : "ok",
					Date.now() - execStart,
				);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				let output = getFinalOutput(result.messages) || "(no output)";
				if (hasQuestions) {
					output = [
						"⚠ CHILD HALTED WITH UNRESOLVED QUESTION(S):",
						formatQuestionList(result.questions!),
						`To continue: re-invoke ${params.agent} with the answer appended to the task (e.g. "Answer to your question '...' is ... — continue"). If you can't decide, ask the user first.`,
						"",
						output,
					].join("\n");
				}
				return {
					content: [{ type: "text", text: output }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			// Find the stored toolResult message matching a "subagent" tool call and return its
			// nested SingleResult when it carries well-formed single-mode SubagentDetails.
			// First match wins (pi toolCallIds are unique per call). Returns undefined (caller
			// falls back to the one-line preview) for anything
			// malformed — rendering must never throw on bad stored data. Reads message history
			// only, so replayed sessions render identically with no live events.
			const findNestedSubagentResult = (messages: Message[], item: DisplayItem): SingleResult | undefined => {
				const callId = typeof item.id === "string" ? item.id : "";
				if (!callId) return undefined;
				for (const msg of messages) {
					try {
						if (!msg || msg.role !== "toolResult") continue;
						if (typeof msg.toolCallId !== "string" || msg.toolCallId !== callId) continue;
						const d = msg.details as SubagentDetails | undefined;
						if (!d || typeof d !== "object") return undefined; // matched result but no details
						if (d.mode !== "single" || !Array.isArray(d.results) || d.results.length !== 1)
							return undefined;
						const nr = d.results[0];
						if (!nr || typeof nr !== "object" || !Array.isArray(nr.messages)) return undefined;
						if (nr.running) return undefined; // in-flight — no completed subtree to render
						return nr as SingleResult;
					} catch {
						return undefined; // malformed message — plain preview line
					}
				}
				return undefined;
			};

			// Expanded single-mode rendering, shared by top-level results (depth 0) and nested
			// subagent results (depth >= 1): each level indents its lines by 2 spaces via paddingX.
			const renderSingleExpanded = (r: SingleResult, depth: number): Container => {
				const pad = 2 * depth;
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				container.addChild(new Text(header, pad, 0));
				if (isError && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), pad, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), pad, 0));
				container.addChild(new Text(theme.fg("dim", r.task), pad, 0));
				container.addChild(new Spacer(1));
				if ((r.progressLog?.length ?? 0) > 0) {
					container.addChild(new Text(theme.fg("muted", "─── Progress ───"), pad, 0));
					for (const p of r.progressLog!) {
						// Normalize whitespace so a multi-line detail can't break the one-line layout.
						const norm = (s: string) => s.replace(/\s+/g, " ").trim();
						const line = p.detail ? `${norm(p.step)} — ${norm(p.detail)}` : norm(p.step);
						container.addChild(new Text(theme.fg("dim", `· ${line}`), pad, 0));
					}
					container.addChild(new Spacer(1));
				}
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), pad, 0));
				if ((r.elidedMessages ?? 0) > 0) {
					container.addChild(new Text(theme.fg("dim", `… ${r.elidedMessages} earlier messages elided (message cap)`), pad, 0));
				}
				if (displayItems.length === 0 && !finalOutput) {
					container.addChild(new Text(theme.fg("muted", "(no output)"), pad, 0));
				} else {
					for (const item of displayItems) {
						if (item.type !== "toolCall") continue;
						container.addChild(renderToolCallItem(item, r.messages, depth));
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), pad, 0, mdTheme));
					}
				}
				const usageStr = r.usage ? formatUsageStats(r.usage, r.model) : ""; // missing usage must not kill the subtree
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), pad, 0));
				}
				return container;
			};

			// One tool-call line for the expanded view. A "subagent" call whose stored result
			// carries SubagentDetails renders as an indented subtree (recursing up to
			// NESTED_RENDER_DEPTH_CAP levels); beyond that, or on any malformed details, it
			// falls back to the plain one-line preview (+ a dim "(truncated)" marker at the cap).
			const renderToolCallItem = (item: DisplayItem, messages: Message[], depth: number): Component => {
				const pad = 2 * depth;
				if (item.name === "subagent" && depth < NESTED_RENDER_DEPTH_CAP) {
					try {
						const nr = findNestedSubagentResult(messages, item);
						if (nr) return renderSingleExpanded(nr, depth + 1); // throws on bad data → plain line below
					} catch { /* malformed nested details — plain line below */ }
				}
				let text = theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme));
				if (item.name === "subagent" && depth >= NESTED_RENDER_DEPTH_CAP) text += theme.fg("dim", " (truncated)");
				return new Text(text, pad, 0);
			};

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			// Compact live line for a still-running result (static glyph — re-renders
			// happen per emitUpdate, no animation timers).
			const runningBody = (r: SingleResult) => {
				let text = theme.fg("dim", ` · turn ${r.turns ?? 1} · ${(r.toolsRun ?? 0)} tools`);
				if (r.progress) {
					const s = r.progress.step.replace(/\s+/g, " ").trim();
					const sprev = Array.from(s).length > 50 ? `${Array.from(s).slice(0, 50).join("")}…` : s;
					text += theme.fg("muted", ` · ${sprev}`);
				}
				if (r.nested) {
					const nt = r.nested.task.replace(/\s+/g, " ").trim();
					const nprev = Array.from(nt).length > 40 ? `${Array.from(nt).slice(0, 40).join("")}…` : nt;
					text += theme.fg(
						"muted",
						` → ${r.nested.agent}${nprev ? ` (${nprev})` : ""}: turn ${r.nested.turns}`,
					);
				}
				const goal = r.task.replace(/\s+/g, " ").trim();
				const preview = Array.from(goal).length > 60 ? `${Array.from(goal).slice(0, 60).join("")}...` : goal;
				return text + `\n${theme.fg("dim", preview)}`;
			};

			const renderRunningLine = (r: SingleResult) => {
				// A failed run (timeout, model error) must not keep showing a healthy spinner.
				if (r.errorMessage) {
					return `${theme.fg("error", "✗")} ${theme.fg("accent", r.agent)} ${theme.fg(
						"error",
						r.errorMessage.replace(/\s+/g, " ").trim(),
					)}`;
				}
				return `${theme.fg("warning", "◐")} ${theme.fg("accent", r.agent)}${runningBody(r)}`;
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				if (r.running) return new Text(renderRunningLine(r), 0, 0);
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) return renderSingleExpanded(r, 0);

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						if (r.running) {
							container.addChild(new Text(`${theme.fg("warning", "◐")}${runningBody(r)}`, 0, 0));
							continue;
						}

						// Show tool calls (nested subagent results render as indented subtrees)
						for (const item of displayItems) {
							if (item.type === "toolCall") container.addChild(renderToolCallItem(item, r.messages, 0));
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)}`;
					if (r.running) {
						text += `${theme.fg("warning", "◐")}${runningBody(r)}`;
						continue;
					}
					const displayItems = getDisplayItems(r.messages);
					text += ` ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls (nested subagent results render as indented subtrees)
						for (const item of displayItems) {
							if (item.type === "toolCall") container.addChild(renderToolCallItem(item, r.messages, 0));
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const isTaskRunning = r.exitCode === -1 || r.running;
					const rIcon = isTaskRunning
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (isTaskRunning) {
						text += runningBody(r);
						continue;
					}
					const displayItems = getDisplayItems(r.messages);
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// Halt protocol: only children (PI_IS_SUBAGENT=1) get the surface_question tool; top-level
	// sessions never see it. The question is recorded as a custom session entry and relayed to
	// the parent via the JSON stream's entry_appended event.
	if (process.env.PI_IS_SUBAGENT === "1") {
		pi.registerTool({
			name: "surface_question",
			label: "Surface Question",
			description:
				"Surface a question you cannot resolve yourself to your orchestrator. Call it, then STOP immediately and end your turn with a brief summary of where you left off.",
			parameters: Type.Object({
				question: Type.String({
					description:
						"The decision or information needed from the orchestrator that cannot be resolved locally.",
				}),
				options: Type.Optional(
					Type.Array(Type.String(), { description: "Candidate answers for the orchestrator to choose from." }),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				// RPC children of a UI-capable parent (PI_SUBAGENT_UI_RELAY=1): relay through the
				// parent's TUI and continue instead of halting. In RPC mode this emits an
				// extension_ui_request that blocks until the parent relays back.
				if (process.env.PI_SUBAGENT_UI_RELAY === "1" && ctx.hasUI) {
					const answer = await ctx.ui.input("Subagent question", params.question);
					return {
						content: [
							{
								type: "text",
								text:
									answer === undefined
										? "Question was cancelled without an answer. Proceed with your best judgment or stop."
										: `Answer received: ${answer}. Continue working.`,
								},
							],
							details: undefined,
					};
				}
				const data = params.options ? { question: params.question, options: params.options } : { question: params.question };
				pi.appendEntry("subagent_question", data);
				return {
					content: [
						{
							type: "text",
							text: "Question recorded and relayed to the orchestrator. STOP working now — end this turn immediately with a 2-3 sentence summary of what you completed so far and exactly which decision you need.",
					},
					],
					details: undefined,
				};
			},
		});

		// Progress protocol: milestone reporting. Unlike surface_question this does NOT stop
		// the child — it records a custom entry relayed to the parent via entry_appended.
		pi.registerTool({
			name: "report_progress",
			label: "Report Progress",
			description:
				"Record a milestone so your orchestrator can see what step you are on. Call at major milestones only (start, phase change, before long operations) — never per tool call. This does NOT stop your work; continue immediately after calling it.",
			parameters: Type.Object({
				step: Type.String({
					description: "Short label for the current milestone, e.g. 'implementing schema migration'.",
				}),
				detail: Type.Optional(Type.String({ description: "Optional one-line detail about this step." })),
			}),

			async execute(_toolCallId, params) {
				const data = params.detail ? { step: params.step, detail: params.detail } : { step: params.step };
				pi.appendEntry("subagent_progress", data);
				return {
					content: [{ type: "text", text: "Progress recorded. Continue working — do not stop." }],
					details: undefined,
				};
			},
		});
	}
}
