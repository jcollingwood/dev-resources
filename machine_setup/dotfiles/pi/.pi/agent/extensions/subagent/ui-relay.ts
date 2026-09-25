/**
 * RPC dialog relay to the parent TUI.
 */

// Watchdog for a single relayed blocking dialog: if the parent UI never resolves within
// this window we answer cancelled/false so the child can't deadlock on an unanswered request.
export const UI_RELAY_TIMEOUT_MS = 120_000;

// Minimal structural type for the parent's UI surface used by RPC dialog relay.
export type ParentUI = {
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
export function raceWithTimeout<T>(p: Promise<T>, ms: number, timers?: Set<NodeJS.Timeout>): Promise<T | undefined> {
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
export function callParentUI(ui: ParentUI, method: string, payload: any): Promise<string | boolean> {
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
