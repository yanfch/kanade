import { describe, expect, it } from "vitest";

import { parseArgs } from "../scripts/live-acceptance-args.ts";

describe("live-acceptance argument parsing", () => {
	it("parses task-level --prepare-command and local --prepare separately", () => {
		const args = parseArgs([
			"--prompt",
			"run this",
			"--prepare",
			"npm install",
			"--prepare-command",
			"npm install",
			"--prepare-command",
			"npm run test",
		]);

		expect(args.prepare).toEqual(["npm install"]);
		expect(args.prepareCommands).toEqual(["npm install", "npm run test"]);
	});

	it("accepts repeatable role-model and run-level model flags", () => {
		const args = parseArgs([
			"--prompt",
			"run this",
			"--role-model",
			"reviewer=gpt-5.4",
			"--role-model",
			"dev=gpt-5.3-codex-spark",
		]);

		expect(args.roleModels).toEqual({ reviewer: "gpt-5.4", dev: "gpt-5.3-codex-spark" });
	});
});
