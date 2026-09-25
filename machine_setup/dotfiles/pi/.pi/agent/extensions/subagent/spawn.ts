/**
 * Child-process lifecycle for subagent invocations.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { CHILD_TIMEOUT_MIN, RPC_ENABLED, SUBAGENT_MAX_TURNS } from "./config.ts";
import { getFinalOutput } from "./results.ts";
import { applyStreamEvent } from "./stream.ts";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.ts";
import { buildUIResponse, callParentUI, raceWithTimeout, UI_RELAY_TIMEOUT_MS, type ParentUI } from "./ui-relay.ts";

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

// Effective turn cap = min of the set values among {caller param, SUBAGENT_MAX_TURNS env};
// neither set → undefined (unlimited). The caller can only tighten the org ceiling.
export function resolveMaxTurns(param: number | undefined): number | undefined {
	const candidates = [param, SUBAGENT_MAX_TURNS].filter(
		(v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
	);
	return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/**
 * Run a single agent task in an isolated pi process.
 */
export async function runSingleAgent(
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
