/**
 * Pure result-model helpers (no TUI, no I/O).
 */

import type { Message } from "@earendil-works/pi-ai";
import { NUDGE_TURNS, SUBAGENT_STORED_MSG_CAP } from "./config.ts";
import type { SingleResult } from "./types.ts";

const PER_TASK_OUTPUT_CAP = 50 * 1024;

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

export function getFinalOutput(messages: Message[]): string {
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

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Numbered question list shared by the single-mode banner and the chain-stop message. */
export function formatQuestionList(questions: { question: string; options?: string[] }[]): string {
	return questions
		.map((q, i) => {
			const opts = q.options && q.options.length > 0 ? ` (options: ${q.options.join("; ")})` : "";
			return `${i + 1}. "${q.question}"${opts}`;
		})
		.join("\n");
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}