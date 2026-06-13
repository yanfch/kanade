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
		expect(config.isolation.prepareCommands).toEqual([]);
		expect(config.isolation.autoCleanupOnReject).toBe(false);
		expect(config.isolation.autoCleanupOnAbort).toBe(false);
		expect(config.defaults.roleModels).toEqual({});
		expect(config.network).toEqual({
			httpProxy: null,
			httpsProxy: null,
			allProxy: null,
			noProxy: null,
			httpIdleTimeoutMs: 300_000,
		});
		expect(config.liveAcceptance).toEqual({ prepare: [], checks: [], timeoutMs: 30 * 60 * 1000, pollMs: 10_000 });
		expect(existsSync(config.paths.worktreesDir)).toBe(true);
	});

	it("loads network proxy defaults from yaml", () => {
		const root = tempKanadeDir();
		writeFileSync(
			join(root, "config.yml"),
			[
				"network:",
				"  httpProxy: http://127.0.0.1:1087",
				"  httpsProxy: http://127.0.0.1:1087",
				"  allProxy: socks5://127.0.0.1:1080",
				"  noProxy: localhost,127.0.0.1",
				"  httpIdleTimeoutMs: 12345",
			].join("\n"),
		);

		const config = loadConfig();

		expect(config.network).toEqual({
			httpProxy: "http://127.0.0.1:1087",
			httpsProxy: "http://127.0.0.1:1087",
			allProxy: "socks5://127.0.0.1:1080",
			noProxy: "localhost,127.0.0.1",
			httpIdleTimeoutMs: 12345,
		});
	});

	it("loads role and live acceptance defaults from yaml", () => {
		const root = tempKanadeDir();
		writeFileSync(
			join(root, "config.yml"),
			[
				"defaults:",
				"  roleModels:",
				"    reviewer: openai-codex:gpt-5.4",
				"liveAcceptance:",
				"  prepare:",
				"    - npm install",
				"  checks:",
				"    - npm run typecheck",
				"  timeoutMs: 1234",
				"  pollMs: 250",
			].join("\n"),
		);

		const config = loadConfig();

		expect(config.defaults.roleModels).toEqual({ reviewer: "openai-codex:gpt-5.4" });
		expect(config.liveAcceptance).toEqual({
			prepare: ["npm install"],
			checks: ["npm run typecheck"],
			timeoutMs: 1234,
			pollMs: 250,
		});
	});

	it("loads isolation.prepareCommands from yaml", () => {
		const root = tempKanadeDir();
		writeFileSync(
			join(root, "config.yml"),
			["isolation:", "  prepareCommands:", "    - npm install", "    - npm run test"].join("\n"),
		);

		const config = loadConfig();

		expect(config.isolation.prepareCommands).toEqual(["npm install", "npm run test"]);
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

	it("normalises models.mode: pi to inherit-pi", () => {
		const root = tempKanadeDir();
		writeFileSync(join(root, "config.yml"), ["models:", "  mode: pi"].join("\n"));

		const config = loadConfig();

		expect(config.models.mode).toBe("inherit-pi");
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

describe("validateConfigPatch", () => {
	it("rejects unknown top-level keys", () => {
		const { validateConfigPatch } = require("./config.ts");
		const result = validateConfigPatch({ unknownKey: { a: 1 } });
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Unknown");
	});

	it("rejects blocked nested fields", () => {
		const { validateConfigPatch } = require("./config.ts");
		const result = validateConfigPatch({ models: { mode: "kanade" } });
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Blocked");
	});

	it("accepts valid editable fields", () => {
		const { validateConfigPatch } = require("./config.ts");
		const result = validateConfigPatch({ defaults: { concurrency: 4 }, debug: { persistSubagents: true } });
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects paths as top-level blocked key", () => {
		const { validateConfigPatch } = require("./config.ts");
		const result = validateConfigPatch({ paths: { root: "/bad" } });
		expect(result.valid).toBe(false);
	});

	it("rejects server as top-level blocked key", () => {
		const { validateConfigPatch } = require("./config.ts");
		const result = validateConfigPatch({ server: { port: 9999 } });
		expect(result.valid).toBe(false);
	});
});

describe("maskConfig", () => {
	it("masks authPath when non-null", () => {
		const { maskConfig } = require("./config.ts");
		const config = loadConfig();
		(config as any).models.authPath = "/tmp/secret.json";
		const masked = maskConfig(config);
		expect(masked.models.authPath).toBe("<configured>");
	});

	it("preserves null authPath", () => {
		const { maskConfig } = require("./config.ts");
		const config = loadConfig();
		const masked = maskConfig(config);
		expect(masked.models.authPath).toBeNull();
	});

	it("includes root and configFile in paths", () => {
		const { maskConfig } = require("./config.ts");
		const config = loadConfig();
		const masked = maskConfig(config);
		expect(masked.paths.root).toBe(config.paths.root);
		expect(masked.paths.configFile).toBe(config.paths.configFile);
	});
});
