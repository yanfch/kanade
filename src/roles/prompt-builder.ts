import type { RoleConfig } from "./loader.ts";

export interface BuildSubagentPromptOptions {
	roleConfig: RoleConfig | null;
	taskPrompt: string;
	label: string;
	phase?: string;
	hasSchema: boolean;
	additionalInstructions?: string;
}

export function buildSubagentPrompt(opts: BuildSubagentPromptOptions): string {
	const parts: string[] = [];

	if (opts.roleConfig) {
		parts.push(`# Role: ${opts.roleConfig.name}\n${opts.roleConfig.systemPrompt}`);
	}

	if (opts.phase) parts.push(`Workflow phase: ${opts.phase}`);
	parts.push(`Task label: ${opts.label}`);

	if (opts.additionalInstructions) {
		parts.push(`Additional instructions:\n${opts.additionalInstructions}`);
	}

	parts.push(opts.taskPrompt);

	if (opts.hasSchema) {
		parts.push(
			[
				"Final output contract:",
				"- Your final action MUST be a structured_output tool call.",
				"- The structured_output arguments are the return value of this subagent.",
				"- Do not emit a prose final answer instead of structured_output.",
				"- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
			].join("\n"),
		);
	}

	return parts.join("\n\n");
}
