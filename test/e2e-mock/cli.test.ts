/**
 * CLI E2E tests — spawn kanade CLI against a real server with mock LLM.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const repoRoot = join(import.meta.dirname, "../..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let BASE_URL = "http://127.0.0.1:17777";
let serverProcess: ReturnType<typeof spawn> | null = null;
let kanadeDir: string;
const extraServerPids: number[] = [];

function splitCliArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error(`Unterminated quote in CLI args: ${input}`);
	if (current) args.push(current);
	return args;
}

function cli(args: string): string {
	try {
		return execFileSync(process.execPath, [tsxCli, "src/bin/kanade.ts", ...splitCliArgs(args)], {
			encoding: "utf8",
			cwd: repoRoot,
			env: { ...process.env, KANADE_URL: BASE_URL, KANADE_DIR: kanadeDir },
			timeout: 15_000,
		}).trim();
	} catch (err) {
		const error = err as { stdout?: string; stderr?: string; message?: string };
		return [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
	}
}

function cliJson(args: string): unknown {
	const out = cli(`${args} --json`);
	return JSON.parse(out);
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`Server not ready at ${url}`);
}

async function waitForTask(taskId: string, status = "finished", timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${BASE_URL}/tasks/${taskId}`);
			const body = (await res.json()) as { task?: { status: string } };
			if (body.task?.status === status) return;
			if (body.task?.status === "failed" && status !== "failed") {
				throw new Error(`Task failed: ${JSON.stringify(body.task.error)}`);
			}
		} catch (err) {
			if ((err as Error).message?.includes("Task failed")) throw err;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Timeout waiting for ${taskId} to reach ${status}`);
}

async function createTask(script: string): Promise<string> {
	const res = await fetch(`${BASE_URL}/tasks`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source: "inline", script }),
	});
	const body = (await res.json()) as { task_id: string };
	await waitForTask(body.task_id);
	return body.task_id;
}

function spawnMainServer(): ReturnType<typeof spawn> {
	const child = spawn(process.execPath, [tsxCli, "src/bin/server.ts"], {
		cwd: repoRoot,
		env: {
			...process.env,
			KANADE_DIR: kanadeDir,
			KANADE_MOCK_SESSION_TEXT: "ok",
			KANADE_MOCK_SESSION_USAGE: JSON.stringify({
				input: 100,
				output: 50,
				cacheRead: 20,
				cacheWrite: 10,
				totalTokens: 180,
				cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0001, total: 0.0032 },
			}),
		},
		stdio: "pipe",
	});
	child.stderr?.on("data", (d) => console.error("[server]", d.toString()));
	return child;
}

async function waitForServerDown(url: string, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${url}/health`);
			if (!res.ok) return;
		} catch {
			return;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Server still reachable at ${url}`);
}

async function stopMainServer(): Promise<void> {
	if (serverProcess) {
		serverProcess.kill("SIGTERM");
		serverProcess = null;
	}
	await waitForServerDown(BASE_URL);
}

async function startMainServer(): Promise<void> {
	serverProcess = spawnMainServer();
	await waitForServer(BASE_URL);
}

async function restartMainServer(): Promise<void> {
	await stopMainServer();
	await startMainServer();
}

async function mutatePersistedUsage(taskId: string, mutate: (usage: Record<string, unknown>) => void): Promise<void> {
	await stopMainServer();
	try {
		const db = new Database(join(kanadeDir, "db", "state.db"));
		try {
			const row = db.prepare("SELECT usage FROM tasks WHERE id = ?").get(taskId) as
				| { usage: string | null }
				| undefined;
			if (!row) throw new Error(`Task not found in state database: ${taskId}`);
			const usage = row.usage ? (JSON.parse(row.usage) as Record<string, unknown>) : {};
			mutate(usage);
			db.prepare("UPDATE tasks SET usage = ? WHERE id = ?").run(JSON.stringify(usage), taskId);
		} finally {
			db.close();
		}
	} finally {
		await startMainServer();
	}
}

beforeAll(async () => {
	kanadeDir = mkdtempSync(join(tmpdir(), "kanade-cli-test-"));
	mkdirSync(join(kanadeDir, "db"), { recursive: true });
	const taskIdPrefix = `C${Math.random().toString(36).slice(2, 6)}`;
	writeFileSync(
		join(kanadeDir, "config.yml"),
		`server:\n  port: 17777\n  bind: 127.0.0.1\nmodels:\n  mode: kanade\ndefaults:\n  taskIdPrefix: ${taskIdPrefix}\n`,
	);
	BASE_URL = "http://127.0.0.1:17777";

	serverProcess = spawnMainServer();
	await waitForServer(BASE_URL);
}, 30_000);

afterAll(() => {
	for (const pid of extraServerPids) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
	}
	if (serverProcess) {
		serverProcess.kill("SIGTERM");
		serverProcess = null;
	}
});

describe("CLI — health", () => {
	it("returns server status", () => {
		const out = cli("health");
		expect(out).toContain("Server is running");
	});
});

describe("CLI — start", () => {
	it("parses --dir and --port when starting a daemon", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-cli-start-"));
		const port = 18777 + Math.floor(Math.random() * 1000);
		const out = cli(`start --dir ${dir} --port ${port} --daemon`);
		expect(out).toContain("Server started in background");
		expect(out).toContain(`Dir:  ${dir}`);
		expect(out).toContain(`Port: ${port}`);
		const match = out.match(/background:\s*(\d+)/);
		expect(match?.[1]).toBeTruthy();
		if (match?.[1]) extraServerPids.push(Number(match[1]));
		await waitForServer(`http://127.0.0.1:${port}`);
	});
});

describe("CLI — ls", () => {
	it("lists tasks", async () => {
		const taskId = await createTask(`export const meta = { name: 'cli-ls', description: 'Test' }\nreturn { ok: true }`);
		const out = cli("ls");
		expect(out).toContain("Tasks");
		expect(out).toContain(taskId);
		expect(out).toContain("finished");
	});

	it("--json returns valid JSON", () => {
		const body = cliJson("ls") as unknown[];
		expect(Array.isArray(body)).toBe(true);
	});

	it("--status filters tasks", () => {
		const body = cliJson("ls --status finished") as Array<{ status: string }>;
		expect(body.length).toBeGreaterThan(0);
		for (const task of body) {
			expect(task.status).toBe("finished");
		}
	});
});

describe("CLI — show", () => {
	it("shows task details", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-show', description: 'Test' }\nreturn { answer: 42 }`,
		);
		const out = cli(`show ${taskId}`);
		expect(out).toContain(taskId);
		expect(out).toContain("finished");
		expect(out).toContain("Journal");
	});

	it("shows recovery hints when a failed task preserves its worktree", async () => {
		const res = await fetch(`${BASE_URL}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "inline",
				script: `export const meta = { name: 'cli-show-failed-preserved', description: 'Test' }\nawait agent('make partial work', { label: 'dev', isolation: 'worktree' })\nthrow new Error('boom')`,
			}),
		});
		const body = (await res.json()) as { task_id: string };
		await waitForTask(body.task_id, "failed");

		try {
			const out = cli(`show ${body.task_id}`);
			expect(out).toContain("Worktree preserved for inspection/recovery");
			expect(out).toContain("Inspect:");
			expect(out).toContain(`kanade reject ${body.task_id}`);
		} finally {
			cli(`reject ${body.task_id}`);
		}
	});

	it("--json returns full task object", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-show-json', description: 'Test' }\nreturn 'done'`,
		);
		const body = cliJson(`show ${taskId}`) as { task: { id: string; status: string }; journal: unknown };
		expect(body.task.id).toBe(taskId);
		expect(body.task.status).toBe("finished");
		expect(body).toHaveProperty("journal");
	});
});

describe("CLI — rerun", () => {
	it("reruns a task and shows from_cache agent call evidence", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-rerun-cache', description: 'Test' }\nreturn await agent('cache me', { label: 'worker' })`,
		);
		const rerun = cliJson(`rerun ${taskId}`) as { task_id: string; rerun_of: string };
		expect(rerun.rerun_of).toBe(taskId);
		await waitForTask(rerun.task_id, "finished");

		const detail = cliJson(`show ${rerun.task_id}`) as { agent_calls: Array<{ status: string }> };
		expect(detail.agent_calls.map((call) => call.status)).toEqual(["from_cache"]);
		const out = cli(`show ${rerun.task_id}`);
		expect(out).toContain("Agent Calls");
		expect(out).toContain("from_cache");
	});

	it("does not mark rerun as from_cache when workspace content changes", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "kanade-cli-cache-workspace-"));
		writeFileSync(join(workspace, "state.txt"), "one\n");
		const res = await fetch(`${BASE_URL}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "inline",
				script: `export const meta = { name: 'cli-rerun-cache-change', description: 'Test' }\nreturn await agent('cache me', { label: 'worker' })`,
				options: { cwd: workspace },
			}),
		});
		const task = (await res.json()) as { task_id: string };
		await waitForTask(task.task_id, "finished");
		writeFileSync(join(workspace, "state.txt"), "two\n");

		const rerun = cliJson(`rerun ${task.task_id}`) as { task_id: string };
		await waitForTask(rerun.task_id, "finished");
		const detail = cliJson(`show ${rerun.task_id}`) as { agent_calls: Array<{ status: string }> };
		expect(detail.agent_calls.map((call) => call.status)).toEqual(["completed"]);
	});
});

describe("CLI — request_human", () => {
	it("lists inbox requests and resumes after respond", async () => {
		const res = await fetch(`${BASE_URL}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "inline",
				script: `export const meta = { name: 'cli-human', description: 'Test' }\nconst response = await request_human({ title: 'Approve?', options: ['yes', 'no'] })\nreturn response`,
			}),
		});
		const task = (await res.json()) as { task_id: string };
		await waitForTask(task.task_id, "needs_human");

		const inbox = cliJson("inbox") as Array<{ request_id: string; task_id: string; payload: unknown }>;
		const request = inbox.find((row) => row.task_id === task.task_id);
		expect(request?.request_id).toBeTruthy();

		const out = cli(`respond ${task.task_id} --request ${request!.request_id} --decision yes`);
		expect(out).toContain("Responded");
		await waitForTask(task.task_id, "finished");
		const detail = cliJson(`show ${task.task_id}`) as { task: { result: string } };
		expect(JSON.parse(detail.task.result)).toEqual({ decision: "yes" });
	});

	it("recovers needs_human task as failed after server restart", async () => {
		const res = await fetch(`${BASE_URL}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "inline",
				script: `export const meta = { name: 'cli-human-restart', description: 'Test' }\nreturn await request_human({ title: 'Approve after restart?', options: ['yes'] })`,
			}),
		});
		const task = (await res.json()) as { task_id: string };
		await waitForTask(task.task_id, "needs_human");
		const inboxBefore = cliJson("inbox") as Array<{ request_id: string; task_id: string }>;
		const request = inboxBefore.find((row) => row.task_id === task.task_id);
		expect(request?.request_id).toBeTruthy();

		await restartMainServer();
		await waitForTask(task.task_id, "failed");

		const detail = cliJson(`show ${task.task_id}`) as { task: { status: string; error: string } };
		expect(detail.task).toMatchObject({
			status: "failed",
			error: "Task recovered: server restarted while task was waiting for human input",
		});
		const inboxAfter = cliJson("inbox") as Array<{ task_id: string }>;
		expect(inboxAfter.some((row) => row.task_id === task.task_id)).toBe(false);
		const respondOut = cli(`respond ${task.task_id} --request ${request!.request_id} --decision yes`);
		expect(respondOut).toContain("Cannot respond to human request for task in failed state");
	}, 20_000);
});

describe("CLI — recovery", () => {
	it("lists actionable recovery tasks by default and supports --all/--state filters", async () => {
		const noWorktreeRes = await fetch(`${BASE_URL}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "inline",
				script: `export const meta = { name: 'cli-recovery-no-wt', description: 'Test' }\nthrow new Error('no worktree')`,
			}),
		});
		const noWorktree = (await noWorktreeRes.json()) as { task_id: string };
		await waitForTask(noWorktree.task_id, "failed");

		const preservedRes = await fetch(`${BASE_URL}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "inline",
				script: `export const meta = { name: 'cli-recovery-preserved', description: 'Test' }\nawait agent('make partial work', { label: 'dev', isolation: 'worktree' })\nthrow new Error('preserved')`,
			}),
		});
		const preserved = (await preservedRes.json()) as { task_id: string };
		await waitForTask(preserved.task_id, "failed");

		try {
			const actionable = cliJson("recovery") as Array<{ id: string; recovery_state: string }>;
			expect(actionable.some((task) => task.id === preserved.task_id && task.recovery_state === "preserved")).toBe(
				true,
			);
			expect(actionable.some((task) => task.id === noWorktree.task_id)).toBe(false);

			const all = cliJson("recovery --all") as Array<{ id: string; recovery_state: string }>;
			expect(all.some((task) => task.id === noWorktree.task_id && task.recovery_state === "no_worktree")).toBe(true);

			const noWorktreeOnly = cliJson("recovery --state no_worktree") as Array<{ id: string }>;
			expect(noWorktreeOnly.some((task) => task.id === noWorktree.task_id)).toBe(true);
			expect(noWorktreeOnly.some((task) => task.id === preserved.task_id)).toBe(false);

			const dryRun = cliJson(`recovery cleanup --task ${preserved.task_id}`) as {
				dry_run: boolean;
				cleaned: number;
				tasks: Array<{ id: string; recovery_state: string }>;
			};
			expect(dryRun).toMatchObject({ dry_run: true, cleaned: 0 });
			expect(dryRun.tasks.some((task) => task.id === preserved.task_id && task.recovery_state === "preserved")).toBe(
				true,
			);
			const blockedCleanup = cli(`recovery cleanup --task ${preserved.task_id} --execute`);
			expect(blockedCleanup).toContain("requires --yes");
			const executedCleanup = cliJson(`recovery cleanup --task ${preserved.task_id} --execute --yes`) as {
				dry_run: boolean;
				cleaned: number;
			};
			expect(executedCleanup).toMatchObject({ dry_run: false, cleaned: 1 });
			const afterCleanup = cliJson("recovery") as Array<{ id: string }>;
			expect(afterCleanup.some((task) => task.id === preserved.task_id)).toBe(false);
		} finally {
			cli(`reject ${preserved.task_id}`);
		}
	});

	it("reconciles a failed task with an explicit branch-tip commit", async () => {
		const res = await fetch(`${BASE_URL}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "inline",
				script: `export const meta = { name: 'cli-reconcile', description: 'Test' }\nawait agent('make partial work', { label: 'dev', isolation: 'worktree' })\nthrow new Error('needs manual merge')`,
			}),
		});
		const task = (await res.json()) as { task_id: string };
		await waitForTask(task.task_id, "failed");
		const before = cliJson(`show ${task.task_id}`) as { worktrees: Array<{ branch: string }> };
		const branch = before.worktrees[0]?.branch;
		expect(branch).toBeTruthy();
		const branchTip = execFileSync("git", ["rev-parse", branch], {
			encoding: "utf8",
			cwd: join(import.meta.dirname, "../.."),
		}).trim();

		try {
			const out = cli(`reconcile ${task.task_id} --merge-commit ${branchTip}`);
			expect(out).toContain("Reconciled manual merge");
			expect(out).toContain(branchTip.slice(0, 12));
			const body = cliJson(`show ${task.task_id}`) as { worktrees: Array<{ status: string; merge_commit: string }> };
			expect(body.worktrees[0]).toMatchObject({ status: "merged", merge_commit: branchTip });
			const actionable = cliJson("recovery") as Array<{ id: string; recovery_state: string }>;
			expect(actionable.some((row) => row.id === task.task_id)).toBe(false);
			const mergedOnly = cliJson("recovery --state merged") as Array<{ id: string; recovery_state: string }>;
			expect(mergedOnly.some((row) => row.id === task.task_id && row.recovery_state === "merged")).toBe(true);
		} finally {
			cli(`reject ${task.task_id}`);
		}
	});
});

describe("CLI — workflows", () => {
	it("lists saved workflows", async () => {
		await fetch(`${BASE_URL}/workflows/cli-wf-test`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-wf-test', description: 'Test WF' }\nreturn 'ok'`,
			}),
		});

		const out = cli("workflows");
		expect(out).toContain("workflow(s)");
	});

	it("--json returns valid JSON", async () => {
		await fetch(`${BASE_URL}/workflows/cli-wf-json`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-wf-json', description: 'Test' }\nreturn 'ok'`,
			}),
		});

		const body = cliJson("workflows") as unknown[];
		expect(Array.isArray(body)).toBe(true);
	});
});

describe("CLI — run", () => {
	it("runs a saved workflow", async () => {
		await fetch(`${BASE_URL}/workflows/cli-run-test`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-run-test', description: 'Test' }\nreturn { ran: true }`,
			}),
		});

		const explicitCwd = tmpdir();
		const out = cli(`run cli-run-test --cwd "${explicitCwd}"`);
		expect(out).toContain("Task");
		expect(out).toContain("created");
	});

	it("uses current working directory when --cwd is not specified", async () => {
		await fetch(`${BASE_URL}/workflows/cli-run-no-cwd`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-run-no-cwd', description: 'Test' }\nreturn { ran: true }`,
			}),
		});

		const projectRoot = join(import.meta.dirname, "../..");
		const out = cli("run cli-run-no-cwd");
		expect(out).toContain("Task");
		expect(out).toContain("created");
		expect(out).toContain("Workspace:");
		expect(out).toContain(projectRoot);
	});

	it("passes subagent routing options, workflow size, and task-level prepare commands for generated runs", async () => {
		const created = cliJson(
			"run --prompt 'return {}' --workflow-size large --agent-model gpt-5.3-codex-spark --role-model reviewer=gpt-5.4 --role-model developer=gpt-5.3-codex-spark --prepare-command 'echo prepare-one' --prepare-command 'echo prepare-two'",
		) as { task_id: string };
		expect(created.task_id).toBeTruthy();
		await waitForTask(created.task_id);

		const body = cliJson(`show ${created.task_id}`) as { task: { options: string } };
		const options = JSON.parse(body.task.options);
		expect(options.author_model).toBeUndefined();
		expect(options.workflow_size).toBe("large");
		expect(options.agent_model).toBe("gpt-5.3-codex-spark");
		expect(options.role_models).toEqual({ reviewer: "gpt-5.4", developer: "gpt-5.3-codex-spark" });
		expect(options.prepare_commands).toEqual(["echo prepare-one", "echo prepare-two"]);
	});

	it("passes split model routing options and task-level prepare commands for saved runs", async () => {
		await fetch(`${BASE_URL}/workflows/cli-run-models`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-run-models', description: 'Test' }\nreturn { ran: true }`,
			}),
		});

		const created = cliJson(
			"run cli-run-models --agent-model gpt-5.4 --role-model reviewer=gpt-5.3-codex-spark --prepare-command 'echo prepare-saved'",
		) as { task_id: string };
		expect(created.task_id).toBeTruthy();
		await waitForTask(created.task_id);

		const body = cliJson(`show ${created.task_id}`) as { task: { options: string } };
		const options = JSON.parse(body.task.options);
		expect(options.agent_model).toBe("gpt-5.4");
		expect(options.role_models).toEqual({ reviewer: "gpt-5.3-codex-spark" });
		expect(options.prepare_commands).toEqual(["echo prepare-saved"]);
	});

	it("generates a workflow script with workflow size hint", () => {
		const out = cli("generate-workflow --prompt 'return {}' --workflow-size small");
		expect(out).toContain("export const meta");
		expect(out).toContain("return {}");
	});

	it("shows workflow size in generated run output", () => {
		const out = cli("run --prompt 'return {}' --workflow-size small");
		expect(out).toContain("Task");
		expect(out).toContain("created");
		expect(out).toContain("Workflow size: small");
	});

	it("shows workspace info in output when --cwd is specified", async () => {
		await fetch(`${BASE_URL}/workflows/cli-run-show-cwd`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-run-show-cwd', description: 'Test' }\nreturn { ran: true }`,
			}),
		});

		const explicitCwd = tmpdir();
		const out = cli(`run cli-run-show-cwd --cwd "${explicitCwd}"`);
		expect(out).toContain("Task");
		expect(out).toContain("created");
		expect(out).toContain("Workspace:");
		expect(out).toContain(explicitCwd);
	});
});

describe("CLI — schedule", () => {
	it("creates and manually runs a saved workflow schedule with prompt and Pi options", async () => {
		await fetch(`${BASE_URL}/workflows/cli-scheduled`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-scheduled', description: 'Test' }\nreturn await agent(args.prompt, { label: 'scheduled' })`,
			}),
		});

		const created = cliJson(
			`schedule add cli-daily --workflow cli-scheduled --prompt 'review repository' --cron '0 9 1 1 *' --timezone Asia/Shanghai --cwd "${tmpdir()}" --thinking-level high --pi-tool read --pi-exclude-tool write --skill "${tmpdir()}"`,
		) as {
			name: string;
			task: { args: { prompt: string }; options: { cwd: string; pi: Record<string, unknown> } };
		};
		expect(created.name).toBe("cli-daily");
		expect(created.task.args.prompt).toBe("review repository");
		expect(created.task.options.cwd).toBe(tmpdir());
		expect(created.task.options.pi).toMatchObject({
			thinking_level: "high",
			tools: ["read"],
			exclude_tools: ["write"],
			skill_paths: [tmpdir()],
		});

		const run = cliJson("schedule run cli-daily") as { status: string; task_id: string };
		expect(run.status).toBe("launched");
		await waitForTask(run.task_id);
		const task = cliJson(`show ${run.task_id}`) as { task: { options: string; schedule_run_id: string } };
		const options = JSON.parse(task.task.options);
		expect(options.pi.thinking_level).toBe("high");
		expect(task.task.schedule_run_id).toBeTruthy();

		const runs = cliJson("schedule runs cli-daily") as { runs: Array<{ task_id: string }> };
		expect(runs.runs[0].task_id).toBe(run.task_id);
		expect(cli("schedule rm cli-daily")).toContain("deleted");
	});
});

describe("CLI — iterate", () => {
	it("iterate via API and verify chain", { timeout: 30_000 }, async () => {
		const t1 = await createTask(`export const meta = { name: 'cli-iter', description: 'Test' }\nreturn 'done'`);

		const res = await fetch(`${BASE_URL}/tasks/${t1}/iterate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instructions: "improve it" }),
		});
		const body = (await res.json()) as { task_id: string };
		await waitForTask(body.task_id);

		const showOut = cli(`show ${body.task_id} --json`) as string;
		const parsed = JSON.parse(showOut);
		expect(parsed.task.id).toBe(body.task_id);
		expect(parsed.task.status).toBe("finished");
	});
});

describe("CLI — show usage", () => {
	it("shows usage section in kanade show output", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-show-usage', description: 'Test' }\nreturn 'done'`,
		);
		const out = cli(`show ${taskId}`);
		expect(out).toContain("Usage & Cost");
		expect(out).toContain("No usage data recorded yet");
	});

	it("shows structured author, agent, and total usage costs", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-show-structured-usage', description: 'Test' }\nreturn 'done'`,
		);
		const usage = {
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 0,
			totalTokens: 66,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 },
			author: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0, total: 0.0033 },
			},
			runtime: {
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0.009, output: 0.018, cacheRead: 0.0027, cacheWrite: 0, total: 0.0297 },
			},
			total: {
				input: 11,
				output: 22,
				cacheRead: 33,
				cacheWrite: 0,
				totalTokens: 66,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 },
			},
		};
		await mutatePersistedUsage(taskId, (current) => Object.assign(current, usage));

		const out = cli(`show ${taskId}`);
		expect(out).toContain("Author Cost:");
		expect(out).toContain("Agent Cost:");
		expect(out).toContain("Total Cost:");
		expect(out).toContain("$0.0330");
		expect(out).toContain("Total Tokens:");
		expect(out).toContain("66");
	});

	it("labels journal cache entries separately from usage and agent call status", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-show-journal-cache', description: 'Test' }\nreturn await agent('hello', { label: 'worker' })`,
		);
		const out = cli(`show ${taskId}`);
		expect(out).toContain("Journal Cache");
		expect(out).toContain("Agent Calls");
		expect(out).toContain("completed");
	});

	it("includes usage in --json output", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-show-usage-json', description: 'Test' }\nreturn 'done'`,
		);
		const body = cliJson(`show ${taskId}`) as { usage: Record<string, unknown> | null };
		expect(body).toHaveProperty("usage");
		expect(body.usage).not.toBeNull();
		expect(body.usage).toHaveProperty("totalTokens");
		expect(body.usage).toHaveProperty("cost");
		expect(body.usage?.cost).toMatchObject({ total: 0 });
	});

	it("includes usage.agents in --json output via real write/read path", async () => {
		// Exercise real write/read path: create a task with agents that emit usage
		const taskId = await createTask(
			`export const meta = { name: 'cli-agents-json', description: 'Test' }\nawait agent('task a', { label: 'dev' })\nawait agent('task b', { label: 'reviewer' })\nreturn 'done'`,
		);

		const body = cliJson(`show ${taskId}`) as { usage: { agents?: unknown[] } };
		expect(body.usage.agents).toBeDefined();
		expect(Array.isArray(body.usage.agents)).toBe(true);
		// Mock emits the same usage for each agent call
		const agents = body.usage.agents as Array<Record<string, unknown>>;
		expect(agents.length).toBeGreaterThanOrEqual(2);
		expect(agents[0]).toHaveProperty("label");
		expect(agents[0]).toHaveProperty("totalTokens");
		expect(agents[0]).toHaveProperty("cost");
	});

	it("renders Per-Agent Usage section via real write/read path", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-agents-section', description: 'Test' }\nawait agent('task a', { label: 'dev' })\nawait agent('task b', { label: 'reviewer' })\nreturn 'done'`,
		);

		const out = cli(`show ${taskId}`);
		expect(out).toContain("Per-Agent Usage");
		expect(out).toContain("dev");
		expect(out).toContain("reviewer");
	});

	it("renders pending label for running agents in Per-Agent Usage", async () => {
		// Inject a running agent with pending flag to test display logic
		const taskId = await createTask(
			`export const meta = { name: 'cli-pending-agents', description: 'Test' }\nreturn 'done'`,
		);
		const agentsArray = [
			{
				label: "dev",
				phase: "Implement",
				model: "m1",
				input: 100,
				output: 50,
				totalTokens: 150,
				cost: { total: 0.01 },
			},
			{
				label: "reviewer",
				phase: "Review",
				model: "m2",
				input: 0,
				output: 0,
				totalTokens: 0,
				cost: { total: 0 },
				pending: true,
			},
		];
		await mutatePersistedUsage(taskId, (usage) => {
			usage.agents = agentsArray;
		});

		const out = cli(`show ${taskId}`);
		expect(out).toContain("Per-Agent Usage");
		expect(out).toContain("dev");
		expect(out).toContain("pending");
	});

	it("preserves existing structured usage when agents is present", async () => {
		// Test back-compat: author/runtime/total usage survives alongside agents
		const taskId = await createTask(
			`export const meta = { name: 'cli-backcompat', description: 'Test' }\nawait agent('task a', { label: 'dev' })\nreturn 'done'`,
		);
		const authorUsage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
		};
		const runtimeUsage = {
			input: 100,
			output: 50,
			cacheRead: 20,
			cacheWrite: 10,
			totalTokens: 180,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0001, total: 0.0032 },
		};
		const totalUsage = {
			input: 110,
			output: 55,
			cacheRead: 20,
			cacheWrite: 10,
			totalTokens: 195,
			cost: { input: 0.0011, output: 0.0022, cacheRead: 0.0001, cacheWrite: 0.0001, total: 0.0035 },
		};
		await mutatePersistedUsage(taskId, (usage) => {
			usage.author = authorUsage;
			usage.runtime = runtimeUsage;
			usage.total = totalUsage;
		});

		const body = cliJson(`show ${taskId}`) as { usage: Record<string, unknown> };
		expect(body.usage.author).toEqual(authorUsage);
		expect(body.usage.runtime).toEqual(runtimeUsage);
		expect(body.usage.total).toEqual(totalUsage);
		expect(Array.isArray(body.usage.agents)).toBe(true);
	});

	it("does not render Per-Agent Usage section when no agents exist", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-no-agents', description: 'Test' }\nreturn 'done'`,
		);
		const out = cli(`show ${taskId}`);
		expect(out).not.toContain("Per-Agent Usage");
	});
});

describe("CLI — save", () => {
	it("saves a task as a workflow", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-save', description: 'Test' }\nreturn { saved: true }`,
		);
		const out = cli(`save ${taskId} --as cli-save-test`);
		expect(out).toContain("Saved as workflow");
		expect(out).toContain("cli-save-test");

		// Verify it exists
		const workflows = cliJson("workflows") as Array<{ name: string }>;
		expect(workflows.some((wf) => wf.name === "cli-save-test")).toBe(true);
	});

	it("rejects duplicate save without --force", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-save-dup', description: 'Test' }\nreturn { dup: true }`,
		);
		// First save succeeds
		cli(`save ${taskId} --as cli-save-dup-test`);

		// Second save with same name should fail
		const out = cli(`save ${taskId} --as cli-save-dup-test`);
		expect(out).toContain("already exists");
	});

	it("allows overwrite with --force", async () => {
		const taskId = await createTask(
			`export const meta = { name: 'cli-save-force', description: 'Test' }\nreturn { forced: true }`,
		);
		// First save
		cli(`save ${taskId} --as cli-save-force-test`);

		// Second save with --force succeeds
		const out = cli(`save ${taskId} --as cli-save-force-test --force`);
		expect(out).toContain("Saved as workflow");
		expect(out).toContain("cli-save-force-test");
	});
});
