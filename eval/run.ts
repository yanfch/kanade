#!/usr/bin/env node
/**
 * Eval runner entry point.
 *
 * Usage:
 *   npx tsx eval/run.ts                    # Run with real LLM
 *   npx tsx eval/run.ts --mock             # Run with mock session
 *   npx tsx eval/run.ts --suite default    # Run specific suite
 */

import { createMockSessionFactory } from "../test/e2e-mock/mock-session.ts";
import { buildReport, formatReport } from "./reporter.ts";
import { runSuite } from "./runner.ts";
import { DEFAULT_SUITE } from "./suites/default.ts";

async function main() {
	const args = process.argv.slice(2);
	const useMock = args.includes("--mock");

	console.log(`\n${useMock ? "🔧 Mock mode" : "🤖 Real LLM mode"}\n`);

	const suite = DEFAULT_SUITE;
	console.log(`Running ${suite.length} eval cases...\n`);

	const opts = useMock ? { createSession: createMockSessionFactory({ text: "mock result" }).createSession } : {};

	const results = await runSuite(suite, opts);
	const report = buildReport(results);
	console.log(formatReport(report));

	// Exit with code 1 if any case failed
	if (report.failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
