/**
 * Unit tests for start command's cmd resolution logic.
 */

import { describe, expect, it } from "vitest";
import { resolveStartCmd } from "./start-cmd.ts";

describe("resolveStartCmd", () => {
	it("uses --cmd when specified", () => {
		const result = resolveStartCmd({
			cmd: "node my-server.js",
			kanadeScriptPath: "/usr/local/bin/kanade.ts",
		});
		expect(result.cmd).toBe("node my-server.js");
		expect(result.source).toBe("explicit");
	});

	it("falls back to kanade cmd path when --cmd not specified", () => {
		const result = resolveStartCmd({
			kanadeScriptPath: "/home/user/kanade/src/bin/kanade.ts",
		});
		expect(result.cmd).toContain("server.ts");
		expect(result.source).toBe("kanade-path");
	});

	it("resolves server.ts from kanade script path", () => {
		const result = resolveStartCmd({
			kanadeScriptPath: "/opt/kanade/src/bin/kanade.ts",
		});
		expect(result.cmd).toBe("npx tsx /opt/kanade/src/bin/server.ts");
	});

	it("handles kanade script path with different directory structures", () => {
		const result = resolveStartCmd({
			kanadeScriptPath: "/some/nested/path/bin/kanade.ts",
		});
		expect(result.cmd).toBe("npx tsx /some/nested/path/bin/server.ts");
	});

	it("uses process.argv[1] as default when kanadeScriptPath not provided", () => {
		// This tests the default behavior when no kanadeScriptPath is provided
		const result = resolveStartCmd({});
		// The result should contain server.ts since we resolve from process.argv[1]
		expect(result.cmd).toContain("server.ts");
		expect(result.source).toBe("kanade-path");
	});

	it("trims whitespace from --cmd", () => {
		const result = resolveStartCmd({
			cmd: "  node server.js  ",
			kanadeScriptPath: "/usr/local/bin/kanade.ts",
		});
		expect(result.cmd).toBe("node server.js");
	});

	it("returns working directory info", () => {
		const result = resolveStartCmd({
			cmd: "node server.js",
			kanadeScriptPath: "/usr/local/bin/kanade.ts",
			cwd: "/tmp/my-project",
		});
		expect(result.cwd).toBe("/tmp/my-project");
	});

	it("defaults working directory to process.cwd()", () => {
		const result = resolveStartCmd({
			cmd: "node server.js",
			kanadeScriptPath: "/usr/local/bin/kanade.ts",
		});
		expect(result.cwd).toBe(process.cwd());
	});
});
