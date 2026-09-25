/**
 * Append-only JSONL delegation log.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Append-only delegation log (~/.local/state/pi-agent/delegations.log). Best-effort:
 * any failure here is swallowed so logging can never break the tool call.
 */
export function logDelegation(
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
