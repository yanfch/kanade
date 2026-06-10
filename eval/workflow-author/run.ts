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
	const modelIndex = args.indexOf("--model");
	const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
	const variantsArg = args.find((arg) => arg.startsWith("--variants="));
	const variants = variantsArg?.split("=")[1]?.split(",").filter(Boolean) as
		| Array<"current-no-read" | "semantic-no-read">
		| undefined;
	const casesArg = args.find((arg) => arg.startsWith("--cases="));
	const caseIds = casesArg?.split("=")[1]?.split(",").filter(Boolean);

	const outputDir = join(tmpdir(), "kanade-eval-artifacts", "workflow-author");
	mkdirSync(outputDir, { recursive: true });

	const results = await runAuthorEval({ model, outputDir, variants, caseIds });
	const report = formatAuthorEval(results);
	console.log(report);
	writeFileSync(join(outputDir, "summary.txt"), report, "utf8");
	writeFileSync(join(outputDir, "summary.json"), JSON.stringify(results, null, 2), "utf8");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
