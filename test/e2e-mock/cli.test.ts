/**
 * CLI E2E tests — spawn kanade CLI against a real server with mock LLM.
 */

import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let BASE_URL = "http://127.0.0.1:17777";
let serverProcess: ReturnType<typeof spawn> | null = null;
let kanadeDir: string;

function cli(args: string): string {
	try {
		return execSync(`npx tsx src/bin/kanade.ts ${args}`, {
			encoding: "utf8",
			cwd: join(import.meta.dirname, "../.."),
			env: { ...process.env, KANADE_URL: BASE_URL, KANADE_DIR: kanadeDir },
			timeout: 15_000,
		}).trim();
	} catch (err) {
		return (err as { stderr?: string }).stderr ?? "";
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

beforeAll(async () => {
	kanadeDir = mkdtempSync(join(tmpdir(), "kanade-cli-test-"));
	mkdirSync(join(kanadeDir, "db"), { recursive: true });
	writeFileSync(join(kanadeDir, "config.yml"), "server:\n  port: 17777\n  bind: 127.0.0.1\n");
	BASE_URL = "http://127.0.0.1:17777";

	serverProcess = spawn("npx", ["tsx", "src/bin/server.ts"], {
		cwd: join(import.meta.dirname, "../.."),
		env: { ...process.env, KANADE_DIR: kanadeDir },
		stdio: "pipe",
	});
	serverProcess.stderr?.on("data", (d) => console.error("[server]", d.toString()));

	await waitForServer(BASE_URL);
}, 30_000);

afterAll(() => {
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

		const out = cli("run cli-run-test --cwd /tmp");
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

	it("shows workspace info in output when --cwd is specified", async () => {
		await fetch(`${BASE_URL}/workflows/cli-run-show-cwd`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				script: `export const meta = { name: 'cli-run-show-cwd', description: 'Test' }\nreturn { ran: true }`,
			}),
		});

		const out = cli("run cli-run-show-cwd --cwd /tmp");
		expect(out).toContain("Task");
		expect(out).toContain("created");
		expect(out).toContain("Workspace:");
		expect(out).toContain("/tmp");
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
