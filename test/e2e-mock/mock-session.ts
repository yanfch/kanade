/**
 * Mock pi SDK session for E2E testing.
 *
 * Mocks createAgentSession at the lowest level — everything above
 * (WorkflowAgent, runtime, TaskManager) runs real code.
 */

import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";

export interface MockScenario {
	/** The response text when no structured_output tool is called */
	text?: string;
	/** If set, automatically call structured_output tool with this value */
	structuredResult?: unknown;
	/** Simulate delay (ms) */
	delay?: number;
	/** If set, throw this error on prompt() */
	error?: Error;
	/** Custom handler: receives prompt, returns what to do */
	handler?: (prompt: string, tools: CreateAgentSessionOptions["customTools"]) => MockAction;
	/** Usage data to include in assistant messages (enables onUsage callback) */
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
}

export type MockAction =
	| { type: "text"; text: string }
	| { type: "structured"; value: unknown }
	| { type: "error"; error: Error };

export interface MockSessionRecord {
	prompts: string[];
	toolNames: string[];
	disposed: boolean;
	aborted: boolean;
}

/**
 * Create a mock createAgentSession function.
 * Returns the factory and a record of all calls made.
 */
export function createMockSessionFactory(scenario: MockScenario = {}) {
	const sessions: MockSessionRecord[] = [];

	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const record: MockSessionRecord = {
			prompts: [],
			toolNames: options.customTools?.map((t) => t.name) ?? [],
			disposed: false,
			aborted: false,
		};
		sessions.push(record);

		// If sessionManager is persisted, write entries so JSONL file is actually created
		const sm = options.sessionManager;
		if (sm?.isPersisted()) {
			sm.newSession();
		}

		const session = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: scenario.text ?? "mock result" }],
					...(scenario.usage ? { usage: scenario.usage } : {}),
				},
			],
			async prompt(text: string) {
				record.prompts.push(text);

				if (scenario.delay) await new Promise((r) => setTimeout(r, scenario.delay));
				if (scenario.error) throw scenario.error;

				// Custom handler
				if (scenario.handler) {
					const action = scenario.handler(text, options.customTools);
					if (action.type === "error") throw action.error;
					if (action.type === "structured") {
						const soTool = options.customTools?.find((t) => t.name === "structured_output");
						if (soTool) await soTool.execute("call-1", action.value, undefined, undefined, undefined as never);
					}
					return;
				}

				// Auto structured output
				if (scenario.structuredResult !== undefined) {
					const soTool = options.customTools?.find((t) => t.name === "structured_output");
					if (soTool) {
						await soTool.execute("call-1", scenario.structuredResult, undefined, undefined, undefined as never);
					}
				}
			},
			async abort() {
				record.aborted = true;
			},
			dispose() {
				record.disposed = true;
				// Flush persisted session on dispose
				if (sm?.isPersisted()) {
					sm.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: scenario.text ?? "mock result" }],
					} as never);
				}
			},
		};

		return { session } as unknown as CreateAgentSessionResult;
	};

	return { createSession, sessions };
}

/**
 * Multi-call mock: returns different results for each agent call.
 */
export function createMultiCallMock(actions: MockAction[]) {
	let callIndex = 0;

	return createMockSessionFactory({
		handler: (_prompt, _tools) => {
			const action = actions[callIndex] ?? { type: "text", text: "default" };
			callIndex++;
			return action;
		},
	});
}
