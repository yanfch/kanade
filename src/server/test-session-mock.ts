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
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
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
			async prompt() {
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

	return { createSession };
}
