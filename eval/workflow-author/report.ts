import type { AuthorEvalResult } from "./scorer.ts";

export function formatAuthorEval(results: AuthorEvalResult[]): string {
	const lines: string[] = [];
	const grouped = new Map<string, AuthorEvalResult[]>();
	for (const result of results) {
		const list = grouped.get(result.caseId) ?? [];
		list.push(result);
		grouped.set(result.caseId, list);
	}

	lines.push("\nWorkflow Author Eval\n");
	for (const [caseId, caseResults] of grouped) {
		lines.push(`${caseId} — ${caseResults[0].caseName}`);
		for (const result of caseResults) {
			lines.push(
				`  ${result.variant.padEnd(16)} score=${result.score.toFixed(3)} steps=${String(result.metrics.primarySteps).padEnd(2)} lowLevel=${result.metrics.lowLevelControlCount} kinds=[${result.metrics.usesKinds.join(", ")}]`,
			);
			if (result.notes.length) lines.push(`    notes: ${result.notes.join("; ")}`);
		}
		if (caseResults.length === 2) {
			const [a, b] = caseResults;
			const better = a.score === b.score ? "tie" : a.score > b.score ? a.variant : b.variant;
			lines.push(`    winner: ${better}`);
		}
		lines.push("");
	}

	const byVariant = new Map<string, AuthorEvalResult[]>();
	for (const result of results) {
		const list = byVariant.get(result.variant) ?? [];
		list.push(result);
		byVariant.set(result.variant, list);
	}
	lines.push("Variant Summary:");
	for (const [variant, variantResults] of byVariant) {
		const avg = variantResults.reduce((sum, r) => sum + r.score, 0) / variantResults.length;
		lines.push(
			`  ${variant.padEnd(16)} avg=${avg.toFixed(3)} pass=${variantResults.filter((r) => r.passed).length}/${variantResults.length}`,
		);
	}
	lines.push("");

	return lines.join("\n");
}
