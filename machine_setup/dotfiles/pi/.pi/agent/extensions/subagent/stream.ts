/**
 * Child JSONL stream-event parsing.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./types.ts";

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
