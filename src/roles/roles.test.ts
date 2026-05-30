import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSubagentPrompt, filterToolsByWhitelist, loadRole } from "./index.ts";

function makeRolesDir(): string {
	return mkdtempSync(join(tmpdir(), "kanade-roles-"));
}

function writeRole(rolesDir: string, name: string): string {
	const dir = join(rolesDir, name);
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "role.md"), "You are a careful developer.\n");
	writeFileSync(join(dir, "tools.json"), JSON.stringify({ allow: ["read", "grep"], extensions: ["custom.ts"] }));
	writeFileSync(
		join(dir, "default-schema.json"),
		JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }),
	);
	writeFileSync(join(dir, "default-model.txt"), "claude-sonnet\n");
	writeFileSync(join(dir, "extensions", "role-tool.ts"), "export {};\n");
	return dir;
}

describe("loadRole", () => {
	it("loads role prompt, tools, defaults, and extension paths", () => {
		const rolesDir = makeRolesDir();
		const roleDir = writeRole(rolesDir, "developer");

		const role = loadRole("developer", { rolesDir });

		expect(role.name).toBe("developer");
		expect(role.dir).toBe(roleDir);
		expect(role.systemPrompt).toBe("You are a careful developer.");
		expect(role.tools).toEqual({ allow: ["read", "grep"], extensions: ["custom.ts"] });
		expect(role.defaultSchema).toEqual({
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		});
		expect(role.defaultModel).toBe("claude-sonnet");
		expect(role.extensionPaths).toEqual([join(roleDir, "custom.ts"), join(roleDir, "extensions", "role-tool.ts")]);
	});

	it("allows missing optional files", () => {
		const rolesDir = makeRolesDir();
		const dir = join(rolesDir, "reviewer");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "role.md"), "Review code.");

		const role = loadRole("reviewer", { rolesDir });

		expect(role.tools).toEqual({ allow: [], extensions: [] });
		expect(role.defaultSchema).toBeUndefined();
		expect(role.defaultModel).toBeUndefined();
		expect(role.extensionPaths).toEqual([]);
	});

	it("rejects invalid role names before touching the filesystem", () => {
		const rolesDir = makeRolesDir();
		expect(() => loadRole("../developer", { rolesDir })).toThrow(/Invalid role name/);
		expect(() => loadRole("Developer", { rolesDir })).toThrow(/Invalid role name/);
	});

	it("validates tools.json shape", () => {
		const rolesDir = makeRolesDir();
		const dir = join(rolesDir, "tester");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "role.md"), "Test things.");
		writeFileSync(join(dir, "tools.json"), JSON.stringify({ allow: "read" }));

		expect(() => loadRole("tester", { rolesDir })).toThrow(/allow/);
	});
});

describe("filterToolsByWhitelist", () => {
	it("keeps only explicitly allowed tools", () => {
		const tools = [{ name: "read" }, { name: "write" }, { name: "grep" }];
		expect(filterToolsByWhitelist(tools, ["read", "grep"])).toEqual([{ name: "read" }, { name: "grep" }]);
	});
});

describe("buildSubagentPrompt", () => {
	it("assembles role identity, workflow context, task, and structured output contract", () => {
		const prompt = buildSubagentPrompt({
			roleConfig: {
				name: "developer",
				dir: "/roles/developer",
				systemPrompt: "You implement small diffs.",
				tools: { allow: ["read"], extensions: [] },
				extensionPaths: [],
			},
			taskPrompt: "Fix the failing test.",
			label: "fix test",
			phase: "开发",
			hasSchema: true,
			additionalInstructions: "Prefer minimal diffs.",
		});

		expect(prompt).toContain("# Role: developer\nYou implement small diffs.");
		expect(prompt).toContain("Workflow phase: 开发");
		expect(prompt).toContain("Task label: fix test");
		expect(prompt).toContain("Additional instructions:\nPrefer minimal diffs.");
		expect(prompt).toContain("Fix the failing test.");
		expect(prompt).toContain("Final output contract:");
	});

	it("omits role and schema contract when not provided", () => {
		const prompt = buildSubagentPrompt({
			roleConfig: null,
			taskPrompt: "Summarize.",
			label: "summary",
			hasSchema: false,
		});

		expect(prompt).not.toContain("# Role:");
		expect(prompt).not.toContain("Final output contract:");
		expect(prompt).toContain("Task label: summary");
		expect(prompt).toContain("Summarize.");
	});
});
