import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const originalKanadeDir = process.env.KANADE_DIR;
const originalTracesDir = process.env.KANADE_TRACES_DIR;

afterEach(() => {
	if (originalKanadeDir === undefined) process.env.KANADE_DIR = undefined;
	else process.env.KANADE_DIR = originalKanadeDir;
	if (originalTracesDir === undefined) process.env.KANADE_TRACES_DIR = undefined;
	else process.env.KANADE_TRACES_DIR = originalTracesDir;
});

function tempKanadeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kanade-config-"));
	process.env.KANADE_DIR = dir;
	process.env.KANADE_TRACES_DIR = undefined;
	return dir;
}

describe("loadConfig", () => {
	it("defaults model config to inheriting pi resources", () => {
		const root = tempKanadeDir();

		const config = loadConfig();

		expect(config.paths.root).toBe(root);
		expect(config.models).toEqual({
			mode: "inherit-pi",
			piAgentDir: null,
			agentDir: null,
			authPath: null,
			modelsPath: null,
			inheritPiSettings: true,
			disableSubagentCompaction: true,
		});
	});

	it("merges explicit kanade model config", () => {
		const root = tempKanadeDir();
		writeFileSync(
			join(root, "config.yml"),
			[
				"models:",
				"  mode: kanade",
				"  agentDir: /tmp/kanade-agent",
				"  authPath: /tmp/kanade-auth.json",
				"  modelsPath: /tmp/kanade-models.json",
				"  inheritPiSettings: false",
				"defaults:",
				"  model: anthropic:claude-sonnet",
			].join("\n"),
		);

		const config = loadConfig();

		expect(config.models.mode).toBe("kanade");
		expect(config.models.agentDir).toBe("/tmp/kanade-agent");
		expect(config.models.authPath).toBe("/tmp/kanade-auth.json");
		expect(config.models.modelsPath).toBe("/tmp/kanade-models.json");
		expect(config.models.inheritPiSettings).toBe(false);
		expect(config.models.disableSubagentCompaction).toBe(true);
		expect(config.defaults.model).toBe("anthropic:claude-sonnet");
	});
});
