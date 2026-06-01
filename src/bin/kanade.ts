#!/usr/bin/env npx tsx
/**
 * kanade CLI — client that talks to the local server via HTTP.
 *
 * Usage: kanade <command> [options]
 */

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

function timestamp(ms: number | null): string {
	if (!ms) return pc.dim("-");
	return new Date(ms).toLocaleString();
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
	const task = (await api(`/tasks/${taskId}`)) as { task: Record<string, unknown> };
	const journal = (await api(`/tasks/${taskId}/journal`)) as { agents: unknown[]; humans: unknown[] };

	if (json) {
		console.log(JSON.stringify({ task: task.task, journal }, null, 2));
		return;
	}

	const t = task.task;

	header(`Task ${pc.bold(String(t.id))}`);

	console.log(`  ${pc.dim("Status:")}    ${statusLabel(String(t.status))}`);
	console.log(
		`  ${pc.dim("Source:")}    ${sourceBadge(String(t.workflow_source))}${t.workflow_name ? ` (${pc.white(String(t.workflow_name))})` : ""}`,
	);
	console.log(`  ${pc.dim("Created:")}   ${timestamp(t.created_at as number)}`);
	console.log(`  ${pc.dim("Started:")}   ${timestamp(t.started_at as number)}`);
	console.log(`  ${pc.dim("Finished:")}  ${timestamp(t.finished_at as number)}`);
	console.log(`  ${pc.dim("Duration:")}  ${duration(t.started_at as number, t.finished_at as number)}`);

	if (t.base_branch) {
		console.log(`  ${pc.dim("Branch:")}    ${t.base_branch}`);
	}

	if (t.error) {
		console.log(`  ${pc.dim("Error:")}     ${pc.red(String(t.error))}`);
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

	if (journal.agents.length > 0) {
		console.log();
		console.log(pc.bold("  Agent Calls"));
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
						const ts = event.ts ? pc.dim(new Date(event.ts).toLocaleTimeString()) : "";
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

async function cmdRun(workflowName: string | undefined, args: ReturnType<typeof parseArgs>["values"]) {
	if (!workflowName) {
		console.error(pc.red("✖ Workflow name required."));
		console.log(pc.dim("  Usage: kanade run <name> --cwd /path [--args '{}'] [--follow]"));
		process.exit(1);
	}

	const cwd = args.cwd as string | undefined;
	if (!cwd) {
		console.error(pc.red("✖ --cwd is required. Tasks must specify a workspace."));
		console.log(pc.dim("  Usage: kanade run <name> --cwd /path [--args '{}']"));
		process.exit(1);
	}

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

	const model = args.model as string | undefined;
	const options: Record<string, unknown> = { cwd };
	if (model) options.model = model;

	const body = (await api("/tasks", {
		method: "POST",
		body: JSON.stringify({ source: "saved", workflow_name: workflowName, args: parsedArgs, options }),
	})) as { task_id: string };

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

	console.log(pc.dim(`Merging ${pc.bold(taskId)} into develop...`));
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

async function cmdReject(taskId: string | undefined) {
	if (!taskId) {
		console.error(pc.red("✖ Task ID required. Usage: kanade reject <task-id>"));
		process.exit(1);
	}

	await api(`/tasks/${taskId}/reject`, { method: "POST" });
	console.log(pc.yellow(`⚑ Task ${pc.bold(taskId)} rejected. Branch removed.`));
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

	const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
	const { join: pathJoin } = await import("node:path");

	const resolvedDir = dir.replace(/^~/, process.env.HOME ?? "");
	if (!existsSync(resolvedDir)) mkdirSync(resolvedDir, { recursive: true });
	mkdirSync(pathJoin(resolvedDir, "db"), { recursive: true });

	const portNum = port ?? "7777";
	writeFileSync(pathJoin(resolvedDir, "config.yml"), `server:\n  port: ${portNum}\n  bind: 127.0.0.1\n`);

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
			model: { type: "string", short: "m" },
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
		case "merge":
			return cmdMerge(positionals[1] as string | undefined);
		case "reject":
			return cmdReject(positionals[1] as string | undefined);
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
  ${pc.cyan("start")}         ${pc.dim("--dir <path> [--port <num>]")}     Start isolated server
  ${pc.cyan("health")}        ${pc.dim("")}                              Check server status
  ${pc.cyan("ls")}            ${pc.dim("[--status <state>] [--json]")}     List tasks
  ${pc.cyan("show")}          ${pc.dim("<task-id> [--json]")}             Task details
  ${pc.cyan("tail")}          ${pc.dim("<task-id>")}                      Follow events (SSE)
  ${pc.cyan("run")}           ${pc.dim("<name> [--args '{}'] [--follow]")} Run saved workflow
  ${pc.cyan("iterate")}       ${pc.dim("<task-id> --instructions '...'")} Iterate on task
  ${pc.cyan("save")}          ${pc.dim("<task-id> --as <name>")}          Save script as workflow
  ${pc.cyan("workflows")}     ${pc.dim("[--json]")}                      List workflows
  ${pc.cyan("merge")}         ${pc.dim("<task-id>")}                     Merge branch
  ${pc.cyan("reject")}        ${pc.dim("<task-id>")}                     Reject, remove branch
  ${pc.cyan("abort")}         ${pc.dim("<task-id>")}                     Abort task
  ${pc.cyan("inbox")}         ${pc.dim("[--json]")}                      Pending requests
  ${pc.cyan("respond")}       ${pc.dim("<task-id> --request <id> --decision <...>")}

${pc.bold("Options:")}
  ${pc.dim("--url, -u <url>")}   Server URL ${pc.dim("(default: http://127.0.0.1:7777)")}
  ${pc.dim("--json, -j")}       Output as JSON
  ${pc.dim("--status, -s")}     Filter by status
  ${pc.dim("--follow, -f")}     Follow events after run

${pc.bold("Isolation:")}
  ${pc.dim("kanade start --dir /tmp/proj-a --port 7778")}
  ${pc.dim("kanade --url http://127.0.0.1:7778 ls")}
`);
}

main().catch((err) => {
	console.error(pc.red(`✖ ${err.message}`));
	process.exit(1);
});
