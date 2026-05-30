import { createHash } from "node:crypto";

export interface HashCallInput {
	prompt: string;
	role?: string | null;
	schema?: unknown;
	model?: string | null;
	instructions?: string | null;
	cwd?: string | null;
}

export function hashCall(input: HashCallInput): string {
	const stable = {
		prompt: input.prompt,
		role: input.role ?? null,
		schema: input.schema ?? null,
		model: input.model ?? null,
		instructions: input.instructions ?? null,
		cwd: input.cwd ?? null,
	};
	return sha256(stableStringify(stable));
}

export function hashHumanRequest(request: unknown, ordinal: number): string {
	return sha256(stableStringify({ ordinal, request }));
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!value || typeof value !== "object") return value;

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		const child = input[key];
		if (child !== undefined) output[key] = sortJson(child);
	}
	return output;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
