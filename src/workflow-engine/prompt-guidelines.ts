// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

export const WORKFLOW_AUTHOR_PROMPT_SNIPPET =
	"Write a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }.";

export const WORKFLOW_AUTHOR_GUIDELINES = [
	"Always output one raw JavaScript string; do not include Markdown fences or prose around the script.",
	"The script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
	"Write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
	"Available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget.",
	"Every workflow should call agent() at least once; do not only declare phases or return a static object.",
	"Use workflows for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis.",
	"parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`.",
	"pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
	"Every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }.",
	"Failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
	"Include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
	"If agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
	"Do not assume subagents have repository code context; include enough task context and relevant paths in each agent prompt.",
] as const;

export function buildWorkflowAuthorPrompt(taskPrompt: string): string {
	return [
		"Write a kanade workflow script for the following task.",
		WORKFLOW_AUTHOR_PROMPT_SNIPPET,
		"Guidelines:",
		...WORKFLOW_AUTHOR_GUIDELINES.map((line) => `- ${line}`),
		"Task:",
		taskPrompt,
		"",
		"Output contract:",
		"- Your final action MUST be a structured_output tool call.",
		"- The structured_output arguments must contain a 'script' field with the complete JavaScript workflow string.",
		"- Do not emit prose or markdown. Call structured_output exactly once with the script.",
	].join("\n");
}
