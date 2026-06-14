#!/usr/bin/env npx tsx
/**
 * kanade CLI — client that talks to the local server via HTTP.
 *
 * Usage: kanade <command> [options]
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import pc from "picocolors";

let BASE_URL = process.env.KANADE_URL ?? "http://127.0.0.1:7777";

// ── Helpers ─────────────────────────────────────────────────────────────────

async function api(path: string, init?: RequestInit): Promise<unknown> {
	const url = `${BASE_URL}${path}`;
	const res = await fetch(url, {
		...init,
		headers: { "Content-Type": "application/json", ...init?.headers },
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
		console.error(pc.red(`✖ Error: ${msg}`));
		process.exit(1);
	}
	return body;
}

function statusIcon(status: string): string {
	switch (status) {
		case "finished":
			return pc.green("✔");
		case "running":
			return pc.cyan("●");
		case "created":
			return pc.dim("○");
		case "needs_human":
			return pc.yellow("⚑");
		case "aborted":
			return pc.red("■");
		case "failed":
			return pc.red("✖");
		case "pending":
			return pc.yellow("◦");
		case "resolved":
			return pc.green("✔");
		default:
			return pc.dim("?");
	}
}

function statusLabel(status: string): string {
	const text = {
		finished: pc.green("finished"),
		running: pc.cyan("running"),
		created: pc.dim("created"),
		needs_human: pc.yellow("needs_human"),
		aborted: pc.red("aborted"),
		failed: pc.red("failed"),
		pending: pc.yellow("pending"),
		resolved: pc.green("resolved"),
	}[status];
	return `${statusIcon(status)} ${text ?? status}`;
}

function sourceBadge(source: string): string {
	switch (source) {
		case "inline":
			return pc.blue("inline");
		case "saved":
			return pc.magenta("saved");
		case "generated":
			return pc.cyan("generated");
		default:
			return source;
	}
}

function recoveryStateLabel(state: string): string {
	switch (state) {
		case "preserved":
			return pc.yellow("preserved");
		case "merged":
			return pc.green("merged");
		case "rejected":
			return pc.dim("rejected");
		default:
			return pc.dim(state);
	}
}

function timestamp(ms: number | null): string {
	if (!ms) return pc.dim("-");
	return new Date(ms).toLocaleString();
}

function formatTimestampWithMs(ms: number): string {
	const d = new Date(ms);
	const hours = String(d.getHours()).padStart(2, "0");
	const minutes = String(d.getMinutes()).padStart(2, "0");
	const seconds = String(d.getSeconds()).padStart(2, "0");
	const milliseconds = String(d.getMilliseconds()).padStart(3, "0");
	return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function duration(start: number | null, end: number | null): string {
	if (!start || !end) return pc.dim("-");
	const ms = end - start;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

function padVisible(s: string, width: number): string {
	const visible = stripAnsi(s).length;
	return `${s}${" ".repeat(Math.max(0, width - visible))}`;
}

function divider(width = 60) {
	console.log(pc.dim("─".repeat(width)));
}

function header(text: string) {
	console.log(pc.bold(text));
	divider(text.length + 10);
}

function printTable(
	rows: Record<string, unknown>[],
	columns: {
		key: string;
		label: string;
		width?: number;
		render?: (val: unknown, row: Record<string, unknown>) => string;
	}[],
) {
	if (rows.length === 0) return;

	// Header
	const headerLine = columns.map((c) => padVisible(pc.bold(pc.dim(c.label)), c.width ?? 12)).join("  ");
	console.log(headerLine);
	console.log(pc.dim(`─${"─".repeat(stripAnsi(headerLine).length + 3)}`));

	// Rows
	for (const row of rows) {
		const line = columns
			.map((c) => {
				const val = row[c.key];
				const str = c.render ? c.render(val, row) : val == null ? pc.dim("-") : String(val);
				return padVisible(str, c.width ?? 12);
			})
			.join("  ");
		console.log(line);
	}
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdLs(args: ReturnType<typeof parseArgs>["values"]) {
	const status = args.status as string | undefined;
	const path = status ? `/tasks?status=${encodeURIComponent(status)}` : "/tasks";
	const body = (await api(path)) as { tasks: Record<string, unknown>[] };
	const json = args.json as boolean;

	if (json) {
		console.log(JSON.stringify(body.tasks, null, 2));
		return;
	}

	if (body.tasks.length === 0) {
		console.log(pc.dim("No tasks found."));
		return;
	}

	header("Tasks");

	printTable(body.tasks, [
		{
			key: "id",
			label: "ID",
			width: 10,
			render: (v) => pc.bold(String(v)),
		},
		{
			key: "status",
			label: "Status",
			width: 14,
			render: (v) => statusLabel(String(v)),
		},
		{
			key: "workflow_source",
			label: "Source",
			width: 10,
			render: (v) => sourceBadge(String(v)),
		},
		{
			key: "workflow_name",
			label: "Workflow",
			width: 20,
			render: (v) => (v ? pc.white(String(v)) : pc.dim("-")),
		},
		{
			key: "created_at",
			label: "Created",
			width: 20,
			render: (v) => timestamp(v as number),
		},
		{
			key: "duration",
			label: "Duration",
			width: 10,
			render: (_, row) => duration(row.started_at as number, row.finished_at as number),
		},
	]);

	console.log(pc.dim(`\n  ${body.tasks.length} task(s)`));
}

async function cmdShow(taskId: string, args: ReturnType<typeof parseArgs>["values"]) {
	const json = args.json as boolean;
	const taskResponse = (await api(`/tasks/${taskId}`)) as {
		task: Record<string, unknown>;
		usage: Record<string, unknown> | null;
	};
	const journal = (await api(`/tasks/${taskId}/journal`)) as { agents: unknown[]; humans: unknown[] };
	const worktrees = (await api(`/tasks/${taskId}/worktrees`)) as { worktrees: Record<string, unknown>[] };

	if (json) {
		console.log(
			JSON.stringify(
				{ task: taskResponse.task, usage: taskResponse.usage, journal, worktrees: worktrees.worktrees },
				null,
				2,
			),
		);
		return;
	}

	const t = taskResponse.task;
	const usage = taskResponse.usage;

	header(`Task ${pc.bold(String(t.id))}`);

	console.log(`  ${pc.dim("Status:")}    ${statusLabel(String(t.status))}`);
	console.log(
		`  ${pc.dim("Source:")}    ${sourceBadge(String(t.workflow_source))}${t.workflow_name ? ` (${pc.white(String(t.workflow_name))})` : ""}`,
	);
	console.log(`  ${pc.dim("Created:")}   ${timestamp(t.created_at as number)}`);
	console.log(`  ${pc.dim("Started:")}   ${timestamp(t.started_at as number)}`);
	console.log(`  ${pc.dim("Finished:")}  ${timestamp(t.finished_at as number)}`);
	console.log(`  ${pc.dim("Duration:")}  ${duration(t.started_at as number, t.finished_at as number)}`);

	// Base branch and isolation info
	console.log(`  ${pc.dim("Base Branch:")} ${t.base_branch ?? pc.dim("-")}`);
	if (worktrees.worktrees.length > 0) {
		const wt = worktrees.worktrees[0];
		console.log(`  ${pc.dim("Isolation:")}   ${pc.cyan("worktree")}`);
		console.log(`  ${pc.dim("Git Branch:")}     ${pc.white(String(wt.branch))}`);
		console.log(`  ${pc.dim("Worktree:")}   ${pc.dim(String(wt.worktree_path))}`);
	} else {
		console.log(`  ${pc.dim("Isolation:")}   ${pc.dim("none")}`);
	}

	if (t.error) {
		console.log(`  ${pc.dim("Error:")}     ${pc.red(String(t.error))}`);
	}

	const terminalFailure = ["failed", "aborted"].includes(String(t.status));
	const preservedWorktrees = worktrees.worktrees.filter((wt) => {
		const path = String(wt.worktree_path ?? "");
		return path.length > 0 && existsSync(path);
	});
	if (terminalFailure && preservedWorktrees.length > 0) {
		console.log();
		console.log(pc.yellow("  Worktree preserved for inspection/recovery."));
		for (const wt of preservedWorktrees) {
			console.log(`  ${pc.dim("Inspect:")}   cd ${pc.white(String(wt.worktree_path))} && git status && git diff`);
		}
		console.log(
			`  ${pc.dim("Cleanup:")}   kanade reject ${String(t.id)} ${pc.dim("# removes preserved worktree/branch")}`,
		);
		console.log(`  ${pc.dim("Keep:")}      do nothing; stale cleanup policy applies later`);
	}

	if (t.result) {
		try {
			const parsed = JSON.parse(t.result as string);
			console.log(`  ${pc.dim("Result:")}    ${JSON.stringify(parsed)}`);
		} catch {
			console.log(`  ${pc.dim("Result:")}    ${t.result}`);
		}
	}

	console.log();
	console.log(
		`  ${pc.dim("Journal:")}   ${pc.white(String(journal.agents.length))} agent entries, ${pc.white(String(journal.humans.length))} human entries`,
	);

	console.log();
	header("Usage & Cost");
	if (!usage) {
		console.log(pc.dim("  No usage data recorded yet."));
	} else {
		const costOf = (value: unknown) => {
			const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			const cost = obj.cost && typeof obj.cost === "object" ? (obj.cost as Record<string, unknown>) : {};
			return Number(cost.total ?? 0);
		};
		const tokensOf = (value: unknown) => {
			const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			return Number(obj.totalTokens ?? 0);
		};
		const hasStructuredUsage =
			(typeof usage.author === "object" && usage.author !== null) ||
			(typeof usage.runtime === "object" && usage.runtime !== null) ||
			(typeof usage.total === "object" && usage.total !== null);

		if (hasStructuredUsage) {
			const authorCost = costOf(usage.author);
			const runtimeCost = costOf(usage.runtime);
			const totalCost = costOf(usage.total ?? usage);
			const totalTokens = tokensOf(usage.total ?? usage);
			console.log(`  ${pc.dim("Author Cost:")}  ${pc.white(`$${authorCost.toFixed(4)}`)}`);
			console.log(`  ${pc.dim("Agent Cost:")}   ${pc.white(`$${runtimeCost.toFixed(4)}`)}`);
			console.log(`  ${pc.dim("Total Cost:")}   ${pc.bold(`$${totalCost.toFixed(4)}`)}`);
			console.log(`  ${pc.dim("Total Tokens:")} ${pc.bold(String(totalTokens))}`);
		} else {
			const inputTokens = Number(usage.input ?? 0);
			const outputTokens = Number(usage.output ?? 0);
			const cacheRead = Number(usage.cacheRead ?? 0);
			const cacheWrite = Number(usage.cacheWrite ?? 0);
			const totalTokens = Number(usage.totalTokens ?? inputTokens + outputTokens + cacheRead + cacheWrite);
			const costTotal = costOf(usage);
			const hasUsage = totalTokens > 0 || costTotal > 0;
			if (!hasUsage) {
				console.log(pc.dim("  No usage data recorded yet."));
			} else {
				console.log(`  ${pc.dim("Input Tokens:")}  ${pc.white(String(inputTokens))}`);
				console.log(`  ${pc.dim("Output Tokens:")} ${pc.white(String(outputTokens))}`);
				console.log(`  ${pc.dim("Cache Read:")}    ${pc.white(String(cacheRead))}`);
				console.log(`  ${pc.dim("Cache Write:")}   ${pc.white(String(cacheWrite))}`);
				console.log(`  ${pc.dim("Total Tokens:")}  ${pc.bold(String(totalTokens))}`);
				console.log(`  ${pc.dim("Cost:")}          ${pc.white(`$${costTotal.toFixed(4)}`)}`);
			}
		}
	}

	// Per-Agent Usage breakdown
	const agents = usage?.agents;
	if (Array.isArray(agents) && agents.length > 0) {
		console.log();
		header("Per-Agent Usage");
		printTable(agents as Record<string, unknown>[], [
			{ key: "label", label: "Label", width: 24, render: (v) => pc.white(String(v ?? "-")) },
			{
				key: "phase",
				label: "Phase",
				width: 14,
				render: (v) => (v ? pc.magenta(String(v)) : pc.dim("-")),
			},
			{
				key: "model",
				label: "Model",
				width: 22,
				render: (v) => (v ? pc.cyan(String(v)) : pc.dim("-")),
			},
			{
				key: "totalTokens",
				label: "Tokens",
				width: 10,
				render: (v, row) => {
					const r = row as Record<string, unknown>;
					return r.pending ? pc.yellow("pending") : pc.white(String(v ?? 0));
				},
			},
			{
				key: "cost",
				label: "Cost",
				width: 12,
				render: (v, row) => {
					const r = row as Record<string, unknown>;
					if (r.pending) return pc.yellow("pending");
					const obj = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
					return pc.white(`$${Number(obj.total ?? 0).toFixed(4)}`);
				},
			},
		]);
	}

	if (journal.agents.length > 0) {
		console.log();
		console.log(pc.bold("  Journal Cache"));
		console.log(pc.dim(`  ${"─".repeat(50)}`));
		for (const entry of journal.agents as Record<string, unknown>[]) {
			const key = String(entry.cache_key ?? "").slice(0, 12);
			const tokens = entry.tokens ?? "?";
			const hits = entry.hit_count ?? 0;
			console.log(`  ${pc.dim(key)}  ${pc.white(String(tokens))} tokens  ${pc.dim(`${hits} hits`)}`);
		}
	}
}

async function cmdTail(taskId: string) {
	console.log(pc.cyan(`Following events for ${pc.bold(taskId)} (Ctrl+C to stop)...\n`));
	const url = `${BASE_URL}/tasks/${taskId}/events`;
	const res = await fetch(url);
	if (!res.ok) {
		console.error(pc.red("✖ Task not found or server unreachable"));
		process.exit(1);
	}

	const reader = res.body?.getReader();
	if (!reader) {
		console.error(pc.red("✖ Cannot read stream"));
		process.exit(1);
	}

	const decoder = new TextDecoder();
	let buffer = "";
	const seenIds = new Set<number>();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					try {
						const event = JSON.parse(line.slice(6));
						// Deduplicate: skip events already seen (replay overlap)
						if (event.id != null) {
							if (seenIds.has(event.id)) continue;
							seenIds.add(event.id);
						}
						const ts = event.ts ? pc.dim(formatTimestampWithMs(event.ts)) : "";
						const type = formatEventType(event.type);
						console.log(`${ts}  ${type}`);
					} catch {
						// skip malformed
					}
				}
			}
		}
	} catch {
		// Ctrl+C
	}
}

function formatEventType(type: string): string {
	if (type === "keepalive") return pc.dim("·");
	if (type.includes("finished")) return pc.green(type);
	if (type.includes("failed") || type.includes("aborted")) return pc.red(type);
	if (type.includes("started") || type.includes("running")) return pc.cyan(type);
	if (type.includes("human")) return pc.yellow(type);
	if (type.includes("phase")) return pc.magenta(type);
	if (type.includes("agent")) return pc.blue(type);
	return type;
}

async function cmdInbox(args: ReturnType<typeof parseArgs>["values"]) {
	const json = args.json as boolean;
	const body = (await api("/inbox")) as { requests: Record<string, unknown>[] };

	if (json) {
		console.log(JSON.stringify(body.requests, null, 2));
		return;
	}

	if (body.requests.length === 0) {
		console.log(pc.green("✔ No pending requests."));
		return;
	}

	header("Inbox");

	printTable(body.requests, [
		{
			key: "request_id",
			label: "Request ID",
			width: 24,
			render: (v) => pc.white(String(v)),
		},
		{
			key: "task_id",
			label: "Task",
			width: 10,
			render: (v) => pc.bold(String(v)),
		},
		{
			key: "status",
			label: "Status",
			width: 10,
			render: (v) => statusLabel(String(v)),
		},
		{
			key: "created_at",
			label: "Created",
			width: 20,
			render: (v) => timestamp(v as number),
		},
	]);
}

async function cmdRespond(taskId: string, args: ReturnType<typeof parseArgs>["values"]) {
	const requestId = args.request as string;
	const decision = args.decision as string;
	if (!requestId || !decision) {
		console.error(pc.red("✖ --request and --decision are required"));
		process.exit(1);
	}
	await api(`/tasks/${taskId}/respond`, {
		method: "POST",
		body: JSON.stringify({ request_id: requestId, response: { decision } }),
	});
	console.log(pc.green(`✔ Responded to ${pc.bold(requestId)} with decision: ${pc.bold(decision)}`));
}

async function cmdAbort(taskId: string) {
	await api(`/tasks/${taskId}/abort`, { method: "POST" });
	console.log(pc.yellow(`⚑ Task ${pc.bold(taskId)} aborted.`));
}

async function cmdKill(taskId: string | undefined) {
	if (!taskId || taskId === "--all") {
		// Kill all running tasks
		const body = (await api("/tasks?status=running")) as { tasks: Array<{ id: string }> };
		if (body.tasks.length === 0) {
			console.log(pc.dim("No running tasks."));
			return;
		}
		for (const task of body.tasks) {
			await killTask(task.id);
		}
		return;
	}
	await killTask(taskId);
}

async function cmdClean() {
	const { execSync } = await import("node:child_process");
	console.log(pc.yellow("Cleaning orphan processes..."));

	// Kill orphan vitest workers
	try {
		execSync("pkill -9 -f 'node.*vitest'", { stdio: "ignore" });
		console.log(pc.dim("  Killed orphan vitest processes"));
	} catch {
		console.log(pc.dim("  No orphan vitest processes"));
	}

	// Kill orphan tsx server processes
	try {
		execSync("pkill -9 -f 'tsx.*server.ts'", { stdio: "ignore" });
		console.log(pc.dim("  Killed orphan server processes"));
	} catch {
		console.log(pc.dim("  No orphan server processes"));
	}

	console.log(pc.green("✔ Done."));
}

async function killTask(taskId: string) {
	try {
		await api(`/tasks/${taskId}/abort`, { method: "POST" });
	} catch {
		// Server might be stuck
	}
	console.log(pc.yellow(`⚑ Task ${pc.bold(taskId)} killed.`));
	console.log(pc.dim("  If CPU is still high, run: kanade clean"));
}

async function cmdGenerateWorkflow(args: ReturnType<typeof parseArgs>["values"]) {
	const prompt = args.prompt as string | undefined;
	if (!prompt?.trim()) {
		console.error(pc.red("✖ --prompt is required."));
		console.log(pc.dim("  Usage: kanade generate-workflow --prompt '...'"));
		process.exit(1);
	}

	const authorModel = (args.author_model ?? args["author-model"]) as string | undefined;
	const workflowSize = parseWorkflowSize(args["workflow-size"]);
	const options: Record<string, unknown> = {};
	if (authorModel) options.author_model = authorModel;
	if (workflowSize) options.workflow_size = workflowSize;
	const body = (await api("/workflows/generate", {
		method: "POST",
		body: JSON.stringify({ prompt, ...(Object.keys(options).length > 0 ? { options } : {}) }),
	})) as { script: string };

	if (args.json) {
		console.log(JSON.stringify(body, null, 2));
		return;
	}
	console.log(body.script);
}

function parseRoleModels(value: unknown): Record<string, string> | undefined {
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	const roleModels: Record<string, string> = {};
	for (const entry of values) {
		if (typeof entry !== "string") continue;
		const sep = entry.indexOf("=");
		if (sep <= 0 || sep === entry.length - 1) {
			throw new Error("--role-model expects role=model");
		}
		roleModels[entry.slice(0, sep)] = entry.slice(sep + 1);
	}
	return Object.keys(roleModels).length ? roleModels : undefined;
}

function parseStringArray(value: unknown): string[] {
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	const out: string[] = [];
	for (const entry of values) {
		if (typeof entry === "string" && entry.trim()) out.push(entry);
	}
	return out;
}

function parseWorkflowSize(value: unknown): "small" | "medium" | "large" | undefined {
	if (value === undefined) return undefined;
	if (value === "small" || value === "medium" || value === "large") return value;
	console.error(pc.red("✖ --workflow-size must be one of: small, medium, large"));
	process.exit(1);
}

function parseRecoveryStateArg(value: unknown): "preserved" | "merged" | "rejected" | "no_worktree" | undefined {
	if (value === undefined) return undefined;
	if (value === "preserved" || value === "merged" || value === "rejected" || value === "no_worktree") return value;
	console.error(pc.red("✖ --state must be one of: preserved, merged, rejected, no_worktree"));
	process.exit(1);
}

async function cmdRun(workflowName: string | undefined, args: ReturnType<typeof parseArgs>["values"]) {
	const prompt = args.prompt as string | undefined;

	// kanade run --prompt '...' → source: generated
	if (!workflowName && prompt?.trim()) {
		const authorModel = (args.author_model ?? args["author-model"]) as string | undefined;
		const agentModel = (args.agent_model ?? args["agent-model"]) as string | undefined;
		const workflowSize = parseWorkflowSize(args["workflow-size"]);
		const cwd = (args.cwd as string | undefined) ?? process.cwd();
		const options: Record<string, unknown> = { cwd };
		if (authorModel) options.author_model = authorModel;
		if (agentModel) options.agent_model = agentModel;
		if (workflowSize) options.workflow_size = workflowSize;
		const roleModels = parseRoleModels(args["role-model"]);
		if (roleModels) options.role_models = roleModels;
		const prepareCommands = parseStringArray(args["prepare-command"]);
		if (prepareCommands.length > 0) options.prepare_commands = prepareCommands;

		const body = (await api("/tasks", {
			method: "POST",
			body: JSON.stringify({ source: "generated", prompt, options }),
		})) as { task_id: string; generated?: boolean };

		if (args.json) {
			console.log(JSON.stringify(body, null, 2));
			return;
		}

		console.log(pc.green(`✔ Task ${pc.bold(body.task_id)} created.`));
		console.log(pc.dim("  Source: generated"));
		if (workflowSize) console.log(pc.dim(`  Workflow size: ${workflowSize}`));
		console.log(pc.dim(`  Workspace: ${cwd}`));

		if (args.follow) {
			console.log();
			await cmdTail(body.task_id);
		} else {
			console.log(pc.dim(`  Run 'kanade tail ${body.task_id}' to follow progress.`));
		}
		return;
	}

	if (!workflowName) {
		console.error(pc.red("✖ Workflow name or --prompt required."));
		console.log(
			pc.dim(
				"  Usage: kanade run <name> [--cwd /path] [--args '{}'] [--agent-model ...] [--role-model reviewer=gpt-5.4] [--prepare-command CMD] [--follow]",
			),
		);
		console.log(
			pc.dim(
				"  Usage: kanade run --prompt '...' [--workflow-size small|medium|large] [--author-model gpt-5.4] [--agent-model gpt-5.3-codex-spark] [--role-model reviewer=gpt-5.4] [--prepare-command CMD] [--follow]",
			),
		);
		process.exit(1);
	}

	// Use specified cwd or default to current working directory
	const cwd = (args.cwd as string | undefined) ?? process.cwd();

	const argsStr = args.args as string | undefined;
	let parsedArgs: unknown;
	if (argsStr) {
		try {
			parsedArgs = JSON.parse(argsStr);
		} catch {
			console.error(pc.red("✖ --args must be valid JSON"));
			process.exit(1);
		}
	}

	const agentModel = (args.agent_model ?? args["agent-model"]) as string | undefined;
	const options: Record<string, unknown> = { cwd };
	if (agentModel) options.agent_model = agentModel;
	const roleModels = parseRoleModels(args["role-model"]);
	if (roleModels) options.role_models = roleModels;
	const prepareCommands = parseStringArray(args["prepare-command"]);
	if (prepareCommands.length > 0) options.prepare_commands = prepareCommands;

	const body = (await api("/tasks", {
		method: "POST",
		body: JSON.stringify({ source: "saved", workflow_name: workflowName, args: parsedArgs, options }),
	})) as { task_id: string };

	if (args.json) {
		console.log(JSON.stringify(body, null, 2));
		return;
	}

	console.log(pc.green(`✔ Task ${pc.bold(body.task_id)} created.`));
	console.log(pc.dim(`  Workflow: ${workflowName}`));
	console.log(pc.dim(`  Workspace: ${cwd}`));

	if (args.follow) {
		console.log();
		await cmdTail(body.task_id);
	} else {
		console.log(pc.dim(`  Run 'kanade tail ${body.task_id}' to follow progress.`));
	}
}

async function cmdSave(taskId: string, args: ReturnType<typeof parseArgs>["values"]) {
	const name = args.as as string;
	if (!name) {
		console.error(pc.red("✖ --as <name> is required"));
		process.exit(1);
	}
	await api(`/tasks/${taskId}/save`, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	console.log(pc.green(`✔ Saved as workflow '${pc.bold(name)}'.`));
}

async function cmdWorkflows(args: ReturnType<typeof parseArgs>["values"]) {
	const json = args.json as boolean;
	const body = (await api("/workflows")) as { workflows: Record<string, unknown>[] };

	if (json) {
		console.log(JSON.stringify(body.workflows, null, 2));
		return;
	}

	if (body.workflows.length === 0) {
		console.log(pc.dim("No saved workflows."));
		return;
	}

	header("Workflows");

	printTable(body.workflows, [
		{
			key: "name",
			label: "Name",
			width: 20,
			render: (v) => pc.bold(pc.magenta(String(v))),
		},
		{
			key: "meta",
			label: "Description",
			width: 40,
			render: (v) => {
				const meta = v as { description?: string } | undefined;
				return pc.white(String(meta?.description ?? "-"));
			},
		},
	]);

	console.log(pc.dim(`\n  ${body.workflows.length} workflow(s)`));
}

async function cmdMerge(taskId: string | undefined) {
	if (!taskId) {
		console.error(pc.red("✖ Task ID required. Usage: kanade merge <task-id>"));
		process.exit(1);
	}

	console.log(pc.dim(`Merging ${pc.bold(taskId)} into the configured target branch...`));
	const body = (await api(`/tasks/${taskId}/merge`, { method: "POST" })) as {
		success: boolean;
		mergeCommit?: string;
		error?: string;
	};

	if (body.success) {
		console.log(pc.green("✔ Merged successfully."));
		if (body.mergeCommit) console.log(pc.dim(`  Commit: ${body.mergeCommit.slice(0, 12)}`));
	} else {
		console.error(pc.red(`✖ Merge failed: ${body.error}`));
		process.exit(1);
	}
}

async function cmdRecovery(args: ReturnType<typeof parseArgs>["values"]) {
	const state = parseRecoveryStateArg(args.state);
	const showAll = Boolean(args.all);
	const actionable = Boolean(args.actionable) || !showAll;
	const query = new URLSearchParams();
	if (state) query.set("state", state);
	if (actionable) query.set("actionable", "true");
	const path = query.size > 0 ? `/recovery?${query}` : "/recovery";
	const body = (await api(path)) as { tasks: Record<string, unknown>[] };
	if (args.json) {
		console.log(JSON.stringify(body.tasks, null, 2));
		return;
	}
	if (body.tasks.length === 0) {
		console.log(pc.green(showAll ? "✔ No failed/aborted tasks need recovery." : "✔ No actionable recovery tasks."));
		return;
	}
	header("Recovery");
	printTable(body.tasks, [
		{ key: "id", label: "ID", width: 10, render: (v) => pc.bold(String(v)) },
		{ key: "status", label: "Status", width: 12, render: (v) => statusLabel(String(v)) },
		{ key: "recovery_state", label: "Recovery", width: 14, render: (v) => recoveryStateLabel(String(v)) },
		{
			key: "worktree_summary",
			label: "Branch/Path",
			width: 34,
			render: (v) => {
				const summary = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
				return pc.dim(String(summary.branch ?? summary.path ?? "-"));
			},
		},
	]);
	console.log(
		pc.dim(
			showAll
				? "\n  Use 'kanade show <id>' to inspect or 'kanade reconcile <id>' after a manual merge."
				: "\n  Showing actionable items only. Use 'kanade recovery --all' to include rejected/no-worktree history.",
		),
	);
}

async function cmdReconcile(taskId: string | undefined, args: ReturnType<typeof parseArgs>["values"]) {
	if (!taskId) {
		console.error(pc.red("✖ Task ID required. Usage: kanade reconcile <task-id> [--merge-commit <sha>]"));
		process.exit(1);
	}
	const mergeCommit = args["merge-commit"] as string | undefined;
	const body = (await api(`/tasks/${taskId}/reconcile`, {
		method: "POST",
		body: JSON.stringify(mergeCommit ? { merge_commit: mergeCommit } : {}),
	})) as { state: string; mergeCommit?: string; branch?: string; message?: string };
	const already = body.state === "already_merged";
	console.log(pc.green(already ? "✔ Already marked merged." : "✔ Reconciled manual merge."));
	if (body.branch) console.log(pc.dim(`  Branch: ${body.branch}`));
	if (body.mergeCommit) console.log(pc.dim(`  Commit: ${body.mergeCommit.slice(0, 12)}`));
	if (body.message) console.log(pc.dim(`  ${body.message}`));
}

async function cmdReject(taskId: string | undefined) {
	if (!taskId) {
		console.error(pc.red("✖ Task ID required. Usage: kanade reject <task-id>"));
		process.exit(1);
	}

	await api(`/tasks/${taskId}/reject`, { method: "POST" });
	console.log(pc.yellow(`⚑ Task ${pc.bold(taskId)} rejected. Preserved worktree/branch removed if present.`));
}

async function cmdIterate(taskId: string | undefined, args: ReturnType<typeof parseArgs>["values"]) {
	if (!taskId) {
		console.error(pc.red("✖ Task ID required. Usage: kanade iterate <task-id> --instructions '...'"));
		process.exit(1);
	}
	const instructions = args.instructions as string | undefined;
	if (!instructions) {
		console.error(pc.red("✖ --instructions is required"));
		process.exit(1);
	}

	const body = (await api(`/tasks/${taskId}/iterate`, {
		method: "POST",
		body: JSON.stringify({ instructions }),
	})) as { task_id: string };

	console.log(pc.green(`✔ Iteration task ${pc.bold(body.task_id)} created.`));
	console.log(pc.dim(`  Parent: ${taskId}`));
	console.log(pc.dim(`  Instructions: ${instructions}`));
}

async function cmdHealth() {
	try {
		const body = (await api("/health")) as { ok: boolean };
		if (body.ok) {
			console.log(pc.green("✔ Server is running at ") + pc.cyan(BASE_URL));
		} else {
			console.log(pc.yellow("⚠ Server returned unhealthy status"));
		}
	} catch {
		console.log(pc.red("✖ Server is not reachable at ") + pc.cyan(BASE_URL));
		process.exit(1);
	}
}

async function cmdStart(args: ReturnType<typeof parseArgs>["values"]) {
	const dir = (args.dir as string | undefined) ?? "~/.kanade";
	const port = args.port as string | undefined;
	const daemon = Boolean(args.daemon);

	const { mkdirSync, writeFileSync, existsSync, openSync, closeSync } = await import("node:fs");
	const { join: pathJoin } = await import("node:path");

	const resolvedDir = dir.replace(/^~/, process.env.HOME ?? "");
	if (!existsSync(resolvedDir)) mkdirSync(resolvedDir, { recursive: true });
	mkdirSync(pathJoin(resolvedDir, "db"), { recursive: true });
	mkdirSync(pathJoin(resolvedDir, "logs"), { recursive: true });

	const portNum = port ?? "7777";
	const configPath = pathJoin(resolvedDir, "config.yml");
	if (!existsSync(configPath)) {
		writeFileSync(configPath, `server:\n  port: ${portNum}\n  bind: 127.0.0.1\n`);
	}

	console.log(pc.green("✔ Starting kanade server"));
	console.log(pc.dim(`  Dir:  ${resolvedDir}`));
	console.log(pc.dim(`  Port: ${portNum}`));
	console.log(pc.dim(`  URL:  http://127.0.0.1:${portNum}`));
	console.log();
	console.log(pc.dim(`  Use:  KANADE_URL=http://127.0.0.1:${portNum} kanade ls`));
	console.log(pc.dim(`  Or:   kanade --url http://127.0.0.1:${portNum} ls`));
	console.log();

	const { spawn } = await import("node:child_process");
	// Find project root by looking for package.json
	let projectRoot = process.cwd();
	while (projectRoot !== "/") {
		if (existsSync(pathJoin(projectRoot, "package.json"))) break;
		projectRoot = pathJoin(projectRoot, "..");
	}
	const tsxPath = pathJoin(projectRoot, "node_modules", ".bin", "tsx");
	if (daemon) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const logPath = pathJoin(resolvedDir, "logs", `server-${stamp}.log`);
		const fd = openSync(logPath, "a");
		const child = spawn(tsxPath, ["src/bin/server.ts"], {
			cwd: projectRoot,
			env: { ...process.env, KANADE_DIR: resolvedDir },
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		child.unref();
		closeSync(fd);
		console.log(pc.green(`✔ Server started in background: ${pc.bold(String(child.pid))}`));
		console.log(pc.dim(`  Log: ${logPath}`));
		return;
	}

	const child = spawn(tsxPath, ["src/bin/server.ts"], {
		cwd: projectRoot,
		env: { ...process.env, KANADE_DIR: resolvedDir },
		stdio: "inherit",
	});

	process.on("SIGINT", () => child.kill("SIGINT"));
	process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			status: { type: "string", short: "s" },
			json: { type: "boolean", short: "j" },
			request: { type: "string" },
			decision: { type: "string", short: "d" },
			note: { type: "string", short: "n" },
			args: { type: "string" },
			as: { type: "string" },
			follow: { type: "boolean", short: "f" },
			url: { type: "string", short: "u" },
			cwd: { type: "string" },
			"author-model": { type: "string" },
			"agent-model": { type: "string" },
			"role-model": { type: "string", multiple: true },
			"prepare-command": { type: "string", multiple: true },
			"workflow-size": { type: "string" },
			"merge-commit": { type: "string" },
			state: { type: "string" },
			actionable: { type: "boolean" },
			all: { type: "boolean" },
			dir: { type: "string" },
			port: { type: "string" },
			prompt: { type: "string", short: "p" },
			daemon: { type: "boolean" },
		},
		strict: false,
		allowPositionals: true,
	});

	const url = values.url as string | undefined;
	if (url) BASE_URL = url;

	const command = positionals[0];

	switch (command) {
		case "ls":
			return cmdLs(values);
		case "show":
			return cmdShow(positionals[1] as string, values);
		case "tail":
			return cmdTail(positionals[1] as string);
		case "inbox":
			return cmdInbox(values);
		case "respond":
			return cmdRespond(positionals[1] as string, values);
		case "abort":
			return cmdAbort(positionals[1] as string);
		case "kill":
			return cmdKill(positionals[1] as string | undefined);
		case "clean":
			return cmdClean();
		case "merge":
			return cmdMerge(positionals[1] as string | undefined);
		case "reconcile":
			return cmdReconcile(positionals[1] as string | undefined, values);
		case "recovery":
			return cmdRecovery(values);
		case "reject":
			return cmdReject(positionals[1] as string | undefined);
		case "generate-workflow":
			return cmdGenerateWorkflow(values);
		case "run":
			return cmdRun(positionals[1] as string | undefined, values);
		case "iterate":
			return cmdIterate(positionals[1] as string | undefined, values);
		case "save":
			return cmdSave(positionals[1] as string, values);
		case "workflows":
			return cmdWorkflows(values);
		case "health":
			return cmdHealth();
		case "start":
			return cmdStart(values);
		case "help":
		case undefined:
			printUsage();
			break;
		default:
			console.error(pc.red(`Unknown command: ${command}`));
			printUsage();
			process.exit(1);
	}
}

function printUsage() {
	console.log(`
${pc.bold("kanade")} — ${pc.dim("Multi-agent workflow runtime CLI")}

${pc.bold("Usage:")}  kanade <command> [options]

${pc.bold("Commands:")}
  ${pc.cyan("start")}         ${pc.dim("[--dir <path>] [--port <num>] [--daemon]")} Start server
  ${pc.cyan("health")}        ${pc.dim("")}                              Check server status
  ${pc.cyan("ls")}            ${pc.dim("[--status <state>] [--json]")}     List tasks
  ${pc.cyan("show")}          ${pc.dim("<task-id> [--json]")}             Task details
  ${pc.cyan("tail")}          ${pc.dim("<task-id>")}                      Follow events (SSE)
  ${pc.cyan("run")}           ${pc.dim("<name> [--cwd /path] [--args '{}'] [--agent-model ...] [--role-model reviewer=...] [--prepare-command cmd] [--follow]")} Run saved workflow
                      ${pc.dim("--prompt '...' [--workflow-size small|medium|large] [--author-model ...] [--agent-model ...] [--role-model reviewer=...] [--prepare-command cmd] [--follow]")} Generate workflow and run
  ${pc.cyan("generate-workflow")} ${pc.dim("--prompt '...' [--workflow-size small|medium|large] [--json]")} Generate workflow script without running
  ${pc.cyan("iterate")}       ${pc.dim("<task-id> --instructions '...'")} Iterate on task
  ${pc.cyan("save")}          ${pc.dim("<task-id> --as <name>")}          Save script as workflow
  ${pc.cyan("workflows")}     ${pc.dim("[--json]")}                      List workflows
  ${pc.cyan("merge")}         ${pc.dim("<task-id>")}                     Merge branch
  ${pc.cyan("reconcile")}     ${pc.dim("<task-id> [--merge-commit sha]")} Mark a manually merged task branch as merged
  ${pc.cyan("recovery")}      ${pc.dim("[--state preserved|merged|rejected|no_worktree] [--all] [--json]")} List recovery tasks
  ${pc.cyan("reject")}        ${pc.dim("<task-id>")}                     Reject, remove branch
  ${pc.cyan("abort")}         ${pc.dim("<task-id>")}                     Abort task
  ${pc.cyan("kill")}          ${pc.dim("<task-id> | --all")}              Force kill task(s)
  ${pc.cyan("clean")}         ${pc.dim("")}                              Kill orphan processes (vitest, etc.)
  ${pc.cyan("inbox")}         ${pc.dim("[--json]")}                      Pending requests
  ${pc.cyan("respond")}       ${pc.dim("<task-id> --request <id> --decision <...>")}

${pc.bold("Options:")}
  ${pc.dim("--url, -u <url>")}   Server URL ${pc.dim("(default: http://127.0.0.1:7777)")}
  ${pc.dim("--json, -j")}       Output as JSON
  ${pc.dim("--status, -s")}     Filter by status
  ${pc.dim("--follow, -f")}     Follow events after run

${pc.bold("Isolation:")}
  ${pc.dim("kanade start --daemon")}
  ${pc.dim("kanade start --dir /tmp/proj-a --port 7778")}
  ${pc.dim("kanade --url http://127.0.0.1:7778 ls")}
`);
}

main().catch((err) => {
	console.error(pc.red(`✖ ${err.message}`));
	process.exit(1);
});
