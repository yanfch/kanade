import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";

export function createMockSessionFactory(scenario: { text?: string } = {}) {
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const sm = options.sessionManager;
		if (sm?.isPersisted()) sm.newSession();

		const session = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: scenario.text ?? "mock result" }],
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
