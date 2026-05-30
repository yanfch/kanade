import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Journal, hashCall, hashHumanRequest, stableStringify } from "./index.ts";

describe("stableStringify", () => {
	it("sorts object keys recursively", () => {
		expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
	});

	it("preserves array order", () => {
		expect(stableStringify({ items: [{ b: 2, a: 1 }, { a: 3 }] })).toBe('{"items":[{"a":1,"b":2},{"a":3}]}');
	});
});

describe("hashCall", () => {
	it("is stable across object key order", () => {
		const first = hashCall({
			prompt: "Do it",
			role: "developer",
			schema: { type: "object", properties: { b: { type: "string" }, a: { type: "boolean" } } },
			model: "anthropic:sonnet",
			instructions: "minimal diff",
			cwd: "/repo",
		});
		const second = hashCall({
			cwd: "/repo",
			instructions: "minimal diff",
			model: "anthropic:sonnet",
			schema: { properties: { a: { type: "boolean" }, b: { type: "string" } }, type: "object" },
			role: "developer",
			prompt: "Do it",
		});

		expect(first).toBe(second);
	});

	it("excludes label and phase by construction", () => {
		const base = hashCall({ prompt: "same", role: "developer" });
		const same = hashCall({ prompt: "same", role: "developer" });
		expect(base).toBe(same);
	});

	it("changes when semantic inputs change", () => {
		expect(hashCall({ prompt: "A" })).not.toBe(hashCall({ prompt: "B" }));
		expect(hashCall({ prompt: "A", model: "m1" })).not.toBe(hashCall({ prompt: "A", model: "m2" }));
	});
});

describe("hashHumanRequest", () => {
	it("includes request ordinal", () => {
		const request = { title: "Approve?", options: ["yes", "no"] };
		expect(hashHumanRequest(request, 1)).toBe(hashHumanRequest({ options: ["yes", "no"], title: "Approve?" }, 1));
		expect(hashHumanRequest(request, 1)).not.toBe(hashHumanRequest(request, 2));
	});
});

describe("Journal", () => {
	function createJournal(): Journal {
		const dir = mkdtempSync(join(tmpdir(), "kanade-journal-"));
		return new Journal(join(dir, "journal.db"));
	}

	it("writes and looks up agent results, incrementing hit count", () => {
		const journal = createJournal();
		try {
			journal.write("key", { result: { ok: true }, tokens: 42 });

			const first = journal.lookup<{ ok: boolean }>("key");
			const second = journal.lookup<{ ok: boolean }>("key");

			expect(first).toMatchObject({ result: { ok: true }, tokens: 42, hitCount: 1 });
			expect(second).toMatchObject({ result: { ok: true }, tokens: 42, hitCount: 2 });
		} finally {
			journal.close();
		}
	});

	it("persists human responses separately", () => {
		const journal = createJournal();
		try {
			journal.writeHuman("human-key", { decision: "approve" });
			expect(journal.lookupHuman("human-key")?.response).toEqual({ decision: "approve" });
			expect(journal.lookup("human-key")).toBeNull();
		} finally {
			journal.close();
		}
	});

	it("returns null for misses", () => {
		const journal = createJournal();
		try {
			expect(journal.lookup("missing")).toBeNull();
			expect(journal.lookupHuman("missing")).toBeNull();
		} finally {
			journal.close();
		}
	});
});
