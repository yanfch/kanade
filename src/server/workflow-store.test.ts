import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowStore } from "./workflow-store.ts";

const VALID_SCRIPT = "export const meta = { name: 'demo', description: 'Demo workflow' }\nreturn { ok: true }";

const SCRIPT_WITH_PHASES = `export const meta = {
  name: 'phased',
  description: 'Has phases',
  phases: [{ title: 'Design' }, { title: 'Build' }],
}
return {}`;

function makeStore(): { store: WorkflowStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "kanade-wf-"));
	return { store: new WorkflowStore(dir), dir };
}

describe("WorkflowStore — list", () => {
	it("returns empty array when directory has no workflows", () => {
		const { store } = makeStore();
		expect(store.list()).toEqual([]);
	});

	it("returns one entry per valid .js file", () => {
		const { store, dir } = makeStore();
		writeFileSync(join(dir, "demo.js"), VALID_SCRIPT, "utf8");
		const list = store.list();
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("demo");
		expect(list[0].meta.name).toBe("demo");
		expect(list[0].script).toBe(VALID_SCRIPT);
	});

	it("skips files whose scripts cannot be parsed", () => {
		const { store, dir } = makeStore();
		writeFileSync(join(dir, "broken.js"), "this is not valid", "utf8");
		writeFileSync(join(dir, "good.js"), VALID_SCRIPT, "utf8");
		const list = store.list();
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("good");
	});

	it("returns entries sorted by name", () => {
		const { store, dir } = makeStore();
		writeFileSync(join(dir, "zzz.js"), VALID_SCRIPT, "utf8");
		writeFileSync(join(dir, "aaa.js"), VALID_SCRIPT, "utf8");
		const names = store.list().map((w) => w.name);
		expect(names).toEqual(["aaa", "zzz"]);
	});
});

describe("WorkflowStore — get", () => {
	it("returns null for an unknown workflow", () => {
		const { store } = makeStore();
		expect(store.get("missing")).toBeNull();
	});

	it("returns null for an invalid name", () => {
		const { store } = makeStore();
		expect(store.get("bad name!")).toBeNull();
		expect(store.get("../escape")).toBeNull();
	});

	it("returns workflow info including parsed meta and script", () => {
		const { store, dir } = makeStore();
		writeFileSync(join(dir, "phased.js"), SCRIPT_WITH_PHASES, "utf8");
		const info = store.get("phased");
		expect(info).not.toBeNull();
		expect(info?.name).toBe("phased");
		expect(info?.meta.phases).toHaveLength(2);
		expect(info?.script).toBe(SCRIPT_WITH_PHASES);
	});

	it("returns null when the script is unparseable", () => {
		const { store, dir } = makeStore();
		writeFileSync(join(dir, "broken.js"), "not a workflow", "utf8");
		expect(store.get("broken")).toBeNull();
	});
});

describe("WorkflowStore — put", () => {
	it("writes the script to <name>.js", () => {
		const { store } = makeStore();
		store.put("my-workflow", VALID_SCRIPT);
		expect(store.get("my-workflow")?.script).toBe(VALID_SCRIPT);
	});

	it("overwrites an existing workflow", () => {
		const { store } = makeStore();
		store.put("wf", VALID_SCRIPT);
		const updated = VALID_SCRIPT.replace("Demo workflow", "Updated");
		store.put("wf", updated);
		expect(store.get("wf")?.script).toBe(updated);
	});

	it("throws for an invalid name", () => {
		const { store } = makeStore();
		expect(() => store.put("bad name!", VALID_SCRIPT)).toThrow();
		expect(() => store.put("", VALID_SCRIPT)).toThrow();
		expect(() => store.put("../escape", VALID_SCRIPT)).toThrow();
	});

	it("throws when the script has no valid meta export", () => {
		const { store } = makeStore();
		expect(() => store.put("wf", "const x = 1")).toThrow();
	});
});

describe("WorkflowStore — delete", () => {
	it("returns false for an unknown workflow", () => {
		const { store } = makeStore();
		expect(store.delete("missing")).toBe(false);
	});

	it("deletes the file and returns true", () => {
		const { store } = makeStore();
		store.put("to-delete", VALID_SCRIPT);
		expect(store.delete("to-delete")).toBe(true);
		expect(store.get("to-delete")).toBeNull();
	});

	it("returns false for an invalid name", () => {
		const { store } = makeStore();
		expect(store.delete("bad name!")).toBe(false);
	});
});
