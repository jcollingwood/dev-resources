/**
 * Formatting + TUI rendering for subagent tool calls and results.
 */

import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import { type AgentScope } from "./agents.ts";
import { getFinalOutput, isFailedResult } from "./results.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

const COLLAPSED_ITEM_COUNT = 10;
// Expanded view renders nested subagent results as indented subtrees up to this many
// levels deep; calls beyond the cap fall back to a one-line preview + "(truncated)" marker.
const NESTED_RENDER_DEPTH_CAP = 3;

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

// Minimal structural theme surface used by the render functions below (pi's Theme satisfies it).
interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export function renderSubagentCall(args: any, theme: RenderTheme): Component {
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
}

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
const renderSingleExpanded = (r: SingleResult, depth: number, theme: RenderTheme, mdTheme: MarkdownTheme): Container => {
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
			container.addChild(renderToolCallItem(item, r.messages, depth, theme, mdTheme));
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
const renderToolCallItem = (item: DisplayItem, messages: Message[], depth: number, theme: RenderTheme, mdTheme: MarkdownTheme): Component => {
	const pad = 2 * depth;
	if (item.name === "subagent" && depth < NESTED_RENDER_DEPTH_CAP) {
		try {
			const nr = findNestedSubagentResult(messages, item);
			if (nr) return renderSingleExpanded(nr, depth + 1, theme, mdTheme); // throws on bad data → plain line below
		} catch { /* malformed nested details — plain line below */ }
	}
	let text = theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme));
	if (item.name === "subagent" && depth >= NESTED_RENDER_DEPTH_CAP) text += theme.fg("dim", " (truncated)");
	return new Text(text, pad, 0);
};

const renderDisplayItems = (items: DisplayItem[], theme: RenderTheme, expanded: boolean, limit?: number) => {
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
const runningBody = (r: SingleResult, theme: RenderTheme) => {
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


const renderRunningLine = (r: SingleResult, theme: RenderTheme) => {
	// A failed run (timeout, model error) must not keep showing a healthy spinner.
	if (r.errorMessage) {
		return `${theme.fg("error", "✗")} ${theme.fg("accent", r.agent)} ${theme.fg(
			"error",
			r.errorMessage.replace(/\s+/g, " ").trim(),
		)}`;
	}
	return `${theme.fg("warning", "◐")} ${theme.fg("accent", r.agent)}${runningBody(r, theme)}`;
};


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

// pi infers the tool-result generic as unknown at the registration site (the original
// inline renderResult was untyped and cast .details directly) — match that here.
export function renderSubagentResult(result: AgentToolResult<unknown>, expanded: boolean, theme: RenderTheme): Component {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		if (r.running) return new Text(renderRunningLine(r, theme), 0, 0);
		const isError = isFailedResult(r);
		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) return renderSingleExpanded(r, 0, theme, mdTheme);

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
		else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(displayItems, theme, expanded, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

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
					container.addChild(new Text(`${theme.fg("warning", "◐")}${runningBody(r, theme)}`, 0, 0));
					continue;
				}

				// Show tool calls (nested subagent results render as indented subtrees)
				for (const item of displayItems) {
					if (item.type === "toolCall") container.addChild(renderToolCallItem(item, r.messages, 0, theme, mdTheme));
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
				text += `${theme.fg("warning", "◐")}${runningBody(r, theme)}`;
				continue;
			}
			const displayItems = getDisplayItems(r.messages);
			text += ` ${rIcon}`;
			if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, theme, expanded, 5)}`;
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
					if (item.type === "toolCall") container.addChild(renderToolCallItem(item, r.messages, 0, theme, mdTheme));
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
				text += runningBody(r, theme);
				continue;
			}
			const displayItems = getDisplayItems(r.messages);
			if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, theme, expanded, 5)}`;
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
}
