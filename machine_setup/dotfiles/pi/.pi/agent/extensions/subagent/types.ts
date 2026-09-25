/**
 * Shared data model for the subagent extension (no logic).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
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

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
