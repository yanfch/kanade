import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";

export function createMockSessionFactory(
	scenario: {
		text?: string;
		/** Usage data to include in assistant messages (enables onUsage callback) */
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		};
	} = {},
) {
	const sessions: Array<{
		prompts: string[];
		thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
		allowedTools?: string[];
		excludedTools?: string[];
		skillNames: string[];
	}> = [];
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const record = {
			prompts: [] as string[],
			thinkingLevel: options.thinkingLevel,
			allowedTools: options.tools,
			excludedTools: options.excludeTools,
			skillNames: options.resourceLoader?.getSkills().skills.map((skill) => skill.name) ?? [],
		};
		sessions.push(record);
		const sm = options.sessionManager;
		if (sm?.isPersisted()) sm.newSession();

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
				return;
			},
			async abort() {
				return;
			},
			dispose() {
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
