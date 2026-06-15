import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptAuthor } from "./author.ts";
import { AUTHOR_EVAL_CASES } from "./cases.ts";
import { type PromptVariant, buildEvalPrompt } from "./prompts.ts";
import { type AuthorEvalResult, scoreAuthorOutput } from "./scorer.ts";

export interface AuthorEvalRunnerOptions {
	model?: string;
	models?: string[];
	outputDir?: string;
	variants?: PromptVariant[];
	caseIds?: string[];
}

export async function runAuthorEval(opts: AuthorEvalRunnerOptions = {}): Promise<AuthorEvalResult[]> {
	const variants = opts.variants ?? ["current-no-read", "semantic-no-read"];
	const outputDir = opts.outputDir ?? join(tmpdir(), "kanade-eval-artifacts", "workflow-author");
	mkdirSync(outputDir, { recursive: true });
	const author = new PromptAuthor({ persistDir: join(outputDir, "debug", "sessions") });
	const models = normalizeModels(opts);
	const cases = opts.caseIds?.length
		? AUTHOR_EVAL_CASES.filter((evalCase) => opts.caseIds?.includes(evalCase.id))
		: AUTHOR_EVAL_CASES;

	const results: AuthorEvalResult[] = [];
	for (const evalCase of cases) {
		for (const variant of variants) {
			for (const model of models) {
				process.stderr.write(`Generating ${evalCase.id} with ${variant} on ${model ?? "default"}... `);
				const prompt = buildEvalPrompt({ evalCase, variant });
				const script = await author.generate(prompt, model ? { model } : undefined);
				const result = scoreAuthorOutput({ evalCase, variant, script, model });
				results.push(result);
				process.stderr.write(`${result.passed ? "PASS" : "WARN"} score=${result.score}\n`);

				const base = join(outputDir, `${evalCase.id}-${variant}-${safeFilePart(model ?? "default")}`);
				writeFileSync(`${base}.prompt.txt`, prompt, "utf8");
				writeFileSync(`${base}.workflow.js`, script, "utf8");
				writeFileSync(`${base}.score.json`, JSON.stringify(result, null, 2), "utf8");
			}
		}
	}

	return results;
}

function normalizeModels(opts: AuthorEvalRunnerOptions): Array<string | undefined> {
	if (opts.models?.length) return opts.models;
	if (opts.model) return [opts.model];
	return [undefined];
}

function safeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
