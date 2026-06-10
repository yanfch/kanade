import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const originalKanadeDir = process.env.KANADE_DIR;
const originalTracesDir = process.env.KANADE_TRACES_DIR;

function unsetEnv(name: string): void {
	Reflect.deleteProperty(process.env, name);
}

afterEach(() => {
	if (originalKanadeDir === undefined) unsetEnv("KANADE_DIR");
	else process.env.KANADE_DIR = originalKanadeDir;
	if (originalTracesDir === undefined) unsetEnv("KANADE_TRACES_DIR");
	else process.env.KANADE_TRACES_DIR = originalTracesDir;
});

function tempKanadeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kanade-config-"));
	process.env.KANADE_DIR = dir;
	unsetEnv("KANADE_TRACES_DIR");
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
		expect(config.paths.worktreesDir).toBe(join(root, "worktrees"));
		expect(config.isolation.worktreeBaseDir).toBe(config.paths.worktreesDir);
		expect(existsSync(config.paths.worktreesDir)).toBe(true);
	});

	it("ignores stringified undefined path env values", () => {
		process.env.KANADE_DIR = "undefined";
		process.env.KANADE_TRACES_DIR = "undefined";

		const config = loadConfig();

		expect(config.paths.root).toBe(join(homedir(), ".kanade"));
		expect(config.paths.tracesDir).toBe(join(config.paths.root, "traces"));
	});

	it("ignores stringified null path env values", () => {
		process.env.KANADE_DIR = "null";
		process.env.KANADE_TRACES_DIR = "null";

		const config = loadConfig();

		expect(config.paths.root).toBe(join(homedir(), ".kanade"));
		expect(config.paths.tracesDir).toBe(join(config.paths.root, "traces"));
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
				"  authorModel: openai:gpt-5.4",
				"  agentModel: openai-codex:gpt-5.3-codex-spark",
			].join("\n"),
		);

		const config = loadConfig();

		expect(config.models.mode).toBe("kanade");
		expect(config.models.agentDir).toBe("/tmp/kanade-agent");
		expect(config.models.authPath).toBe("/tmp/kanade-auth.json");
		expect(config.models.modelsPath).toBe("/tmp/kanade-models.json");
		expect(config.models.inheritPiSettings).toBe(false);
		expect(config.models.disableSubagentCompaction).toBe(true);
		expect(config.defaults.authorModel).toBe("openai:gpt-5.4");
		expect(config.defaults.agentModel).toBe("openai-codex:gpt-5.3-codex-spark");
	});
});
