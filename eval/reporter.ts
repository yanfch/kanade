/**
 * Eval reporter — formats EvalReport as a terminal table.
 */

import type { EvalReport, EvalResult } from "./types.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function pct(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function bar(ratio: number, width = 12): string {
	const filled = Math.round(ratio * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function statusColor(passed: boolean): string {
	return passed ? GREEN : RED;
}

function scoreColor(score: number): string {
	if (score >= 0.9) return GREEN;
	if (score >= 0.8) return YELLOW;
	return RED;
}

/** Format a single result row */
function formatRow(result: EvalResult): string {
	const pass = result.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
	const score = `${scoreColor(result.score)}${pct(result.score)}${RESET}`;
	const breakdown = `${result.breakdown.completion}/${result.breakdown.correctness}/${result.breakdown.efficiency}`;
	const metrics = `${result.metrics.agentCalls} agents, ${result.metrics.durationMs}ms`;
	return `  ${result.caseId}  ${pass}  ${score}  ${result.caseName.padEnd(25)}  ${breakdown}  ${metrics}`;
}

/** Generate a formatted eval report for terminal output */
export function formatReport(report: EvalReport): string {
	const lines: string[] = [];

	lines.push("");
	lines.push(`${BOLD}┌${"─".repeat(70)}┐${RESET}`);
	lines.push(`${BOLD}│${" ".repeat(15)}Kanade Evaluation Report${" ".repeat(30)}│${RESET}`);
	lines.push(`${BOLD}│${" ".repeat(15)}${DIM}${report.timestamp}${RESET}${" ".repeat(30)}│${RESET}`);
	lines.push(`${BOLD}├${"─".repeat(70)}┤${RESET}`);

	// Summary
	const passColor = report.failed === 0 ? GREEN : RED;
	lines.push(
		`│  Total: ${report.total} cases    ${GREEN}Passed: ${report.passed}${RESET}    ${passColor}Failed: ${report.failed}${RESET}    Score: ${scoreColor(report.avgScore)}${pct(report.avgScore)}${RESET}`,
	);
	lines.push(`${BOLD}├${"─".repeat(70)}┤${RESET}`);

	// By category
	lines.push("│  By Category:");
	for (const [cat, stats] of Object.entries(report.byCategory)) {
		const catBar = bar(stats.passed / stats.total);
		const catColor = stats.passed === stats.total ? GREEN : YELLOW;
		lines.push(
			`│    ${cat.padEnd(12)} ${stats.passed}/${stats.total}  ${catColor}${catBar}${RESET}  ${pct(stats.avgScore)}`,
		);
	}
	lines.push(`${BOLD}├${"─".repeat(70)}┤${RESET}`);

	// Results
	lines.push("│  Results:");
	for (const result of report.results) {
		lines.push(formatRow(result));
	}
	lines.push(`${BOLD}├${"─".repeat(70)}┤${RESET}`);

	// Failed cases detail
	const failed = report.results.filter((r) => !r.passed);
	if (failed.length > 0) {
		lines.push("│  Failed Cases:");
		for (const result of failed) {
			lines.push(`│    ${result.caseId} ${result.caseName}: score=${pct(result.score)} status=${result.actualStatus}`);
			if (result.error) lines.push(`│      error: ${result.error}`);
		}
	} else {
		lines.push(`│  ${GREEN}All cases passed!${RESET}`);
	}

	lines.push(`${BOLD}└${"─".repeat(70)}┘${RESET}`);
	lines.push("");

	return lines.join("\n");
}

/** Build an EvalReport from a list of EvalResults */
export function buildReport(results: EvalResult[]): EvalReport {
	const passed = results.filter((r) => r.passed).length;
	const avgScore = results.reduce((sum, r) => sum + r.score, 0) / (results.length || 1);

	const byCategory: Record<string, { total: number; passed: number; avgScore: number }> = {};
	for (const result of results) {
		if (!byCategory[result.category]) {
			byCategory[result.category] = { total: 0, passed: 0, avgScore: 0 };
		}
		const cat = byCategory[result.category];
		cat.total++;
		if (result.passed) cat.passed++;
		cat.avgScore += result.score;
	}
	for (const cat of Object.values(byCategory)) {
		cat.avgScore = Math.round((cat.avgScore / cat.total) * 1000) / 1000;
	}

	return {
		timestamp: new Date().toISOString(),
		total: results.length,
		passed,
		failed: results.length - passed,
		avgScore: Math.round(avgScore * 1000) / 1000,
		results,
		byCategory,
	};
}
