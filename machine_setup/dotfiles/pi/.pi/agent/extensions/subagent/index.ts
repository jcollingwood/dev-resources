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
 *
 * Module layout (this file is entry point + orchestration only):
 *   types.ts          shared data model
 *   config.ts         env/policy constants parsed at load
 *   results.ts        pure result-model helpers
 *   stream.ts         child JSONL stream-event parsing
 *   ui-relay.ts       RPC dialog relay to the parent TUI
 *   delegation-log.ts append-only JSONL delegation log
 *   display.ts        formatting + TUI rendering
 *   spawn.ts          child-process lifecycle (runSingleAgent)
 *   schema.ts         tool parameter schema
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { logDelegation } from "./delegation-log.ts";
import { renderSubagentCall, renderSubagentResult } from "./display.ts";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, NUDGE_ENABLED, PARALLEL_ENABLED, RPC_ENABLED, SUBAGENT_MAX_DEPTH } from "./config.ts";
import { capStoredMessages, formatQuestionList, getFinalOutput, getResultOutput, isFailedResult, shouldNudge, truncateParallelOutput } from "./results.ts";
import { SubagentParams } from "./schema.ts";
import { resolveMaxTurns, runSingleAgent } from "./spawn.ts";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.ts";

export { capStoredMessages, shouldNudge } from "./results.ts";
export { applyStreamEvent } from "./stream.ts";
export { buildUIResponse } from "./ui-relay.ts";

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

		renderCall(args, theme) { return renderSubagentCall(args, theme); },

		renderResult(result, { expanded }, theme) { return renderSubagentResult(result, expanded, theme); },
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
