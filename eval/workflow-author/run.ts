#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureHttpDispatcher } from "../../src/net/http-dispatcher.ts";
import { formatAuthorEval } from "./report.ts";
import { runAuthorEval } from "./runner.ts";

async function main() {
	configureHttpDispatcher();
	const args = process.argv.slice(2);
	const model = getArgValue(args, "--model");
	const models = getArgValue(args, "--models")?.split(",").filter(Boolean);
	const variants = getArgValue(args, "--variants")?.split(",").filter(Boolean) as
		| Array<"current-no-read" | "semantic-no-read">
		| undefined;
	const caseIds = getArgValue(args, "--cases")?.split(",").filter(Boolean);

	const outputDir = join(tmpdir(), "kanade-eval-artifacts", "workflow-author");
	mkdirSync(outputDir, { recursive: true });

	const results = await runAuthorEval({ model, models, outputDir, variants, caseIds });
	const report = formatAuthorEval(results);
	console.log(report);
	writeFileSync(join(outputDir, "summary.txt"), report, "utf8");
	writeFileSync(join(outputDir, "summary.json"), JSON.stringify(results, null, 2), "utf8");
}

function getArgValue(args: string[], name: string): string | undefined {
	const inline = args.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
