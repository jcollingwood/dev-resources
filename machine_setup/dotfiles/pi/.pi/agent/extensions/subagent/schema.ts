/**
 * Tool parameter schema for the subagent tool.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { PARALLEL_ENABLED } from "./config.ts";

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

export const SubagentParams = Type.Object({
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
