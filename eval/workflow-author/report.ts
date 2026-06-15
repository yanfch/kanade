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
				`  ${result.variant.padEnd(16)} ${result.model.padEnd(28)} score=${result.score.toFixed(3)} size=${result.metrics.workflowSize.padEnd(6)} fit=${formatBool(result.metrics.workflowSizeFit)} steps=${String(result.metrics.primarySteps).padEnd(2)} agents=${String(result.metrics.agentCountEstimate).padEnd(2)} review=${formatBool(result.metrics.hasReview)} test=${formatBool(result.metrics.hasTest)} human=${formatBool(result.metrics.hasHumanGate)} raw=${formatBool(result.metrics.usesRawAgent || result.metrics.usesRawPipeline)} parse=${formatBool(result.metrics.parseOk)} parallel=${formatBool(result.metrics.usesParallel)} project=${formatBool(result.metrics.projectAgnostic)} kinds=[${result.metrics.usesKinds.join(", ")}]`,
			);
			if (result.notes.length) lines.push(`    notes: ${result.notes.join("; ")}`);
		}
		lines.push(...formatCaseComparisons(caseResults));
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

	const byModel = new Map<string, AuthorEvalResult[]>();
	for (const result of results) {
		const list = byModel.get(result.model) ?? [];
		list.push(result);
		byModel.set(result.model, list);
	}
	lines.push("Model Summary:");
	for (const [model, modelResults] of byModel) {
		const avg = modelResults.reduce((sum, r) => sum + r.score, 0) / modelResults.length;
		const fit = modelResults.filter((r) => r.metrics.workflowSizeFit).length;
		const raw = modelResults.filter((r) => r.metrics.usesRawAgent || r.metrics.usesRawPipeline).length;
		lines.push(
			`  ${model.padEnd(28)} avg=${avg.toFixed(3)} pass=${modelResults.filter((r) => r.passed).length}/${modelResults.length} sizeFit=${fit}/${modelResults.length} raw=${raw}/${modelResults.length}`,
		);
	}
	lines.push("");

	return lines.join("\n");
}

function formatCaseComparisons(caseResults: AuthorEvalResult[]): string[] {
	const lines: string[] = [];
	const byVariant = new Map<string, AuthorEvalResult[]>();
	for (const result of caseResults) {
		const list = byVariant.get(result.variant) ?? [];
		list.push(result);
		byVariant.set(result.variant, list);
	}

	for (const [variant, variantResults] of byVariant) {
		if (variantResults.length < 2) continue;
		const sorted = [...variantResults].sort((a, b) => b.score - a.score);
		const best = sorted[0];
		const baseline = sorted[sorted.length - 1];
		const delta = best.score - baseline.score;
		lines.push(`    ${variant} model winner: ${best.model} Δ=${delta.toFixed(3)} vs ${baseline.model}`);
	}

	if (caseResults.length === 2 && caseResults[0].model === caseResults[1].model) {
		const [a, b] = caseResults;
		const better = a.score === b.score ? "tie" : a.score > b.score ? a.variant : b.variant;
		lines.push(`    variant winner: ${better}`);
	}

	return lines;
}

function formatBool(value: boolean): string {
	return value ? "Y" : "N";
}
