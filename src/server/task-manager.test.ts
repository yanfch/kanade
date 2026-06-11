import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { buildWorkflowAuthorPrompt } from "../workflow-engine/prompt-guidelines.ts";
import { detectProjectProfile } from "../workspace/project-profile.ts";
import { EventBus } from "./event-bus.ts";
import { TaskManager, resolveConfiguredAgentDir } from "./task-manager.ts";
import { createMockSessionFactory } from "./test-session-mock.ts";

const SIMPLE_SCRIPT = "export const meta = { name: 'demo', description: 'Demo' }\nreturn { ok: true }";

function currentBranch(): string {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
	} catch {
		return "main";
	}
}

function createTemporaryGitRepo(branch = "feature/test-branch"): { repo: string; child: string } {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "kanade-task-base-")));
	const child = join(repo, "nested", "project");
	mkdirSync(child, { recursive: true });
	execSync("git init", { cwd: repo, stdio: "ignore" });
	execSync(`git checkout -b ${branch}`, { cwd: repo, stdio: "ignore" });
	writeFileSync(join(repo, "README.md"), "test repo\n");
	execSync("git add README.md", { cwd: repo, stdio: "ignore" });
	execSync("git -c user.name='Kanade Test' -c user.email='kanade@example.com' commit -m 'init'", {
		cwd: repo,
		stdio: "ignore",
	});
	return { repo, child };
}

function setup(
	author?: { generate(prompt: string, options?: { model?: string; workspaceRoot?: string }): Promise<string> },
	sessionFactory?: ConstructorParameters<typeof TaskManager>[6],
) {
	const root = mkdtempSync(join(tmpdir(), "kanade-server-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	config.models.mode = "kanade";
	config.defaults.taskIdPrefix = `UT${Math.random().toString(36).slice(2, 6)}`;
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { initialPollMs: 5 });
	const manager = new TaskManager(config, store, events, humanGate, author, undefined, sessionFactory);
	return { config, store, events, manager };
}

describe("TaskManager — model configuration", () => {
	it("inherits the default Pi agent dir when models.mode is inherit-pi", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-server-"));
		process.env.KANADE_DIR = root;
		const config = loadConfig();
		config.models.mode = "inherit-pi";
		config.models.agentDir = null;
		config.models.piAgentDir = null;

		expect(resolveConfiguredAgentDir(config)).toBe(getAgentDir());
	});

	it("does not infer Pi agent dir in kanade model mode without explicit dirs", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-server-"));
		process.env.KANADE_DIR = root;
		const config = loadConfig();
		config.models.mode = "kanade";
		config.models.agentDir = null;
		config.models.piAgentDir = null;

		expect(resolveConfiguredAgentDir(config)).toBeUndefined();
	});
});

describe("TaskManager — core", () => {
	it("skips task ids whose worktree branch already exists", () => {
		const prefix = `UTbr${Math.random().toString(36).slice(2, 8)}`;
		const existingBranch = `kanade/${prefix}-0001`;
		execSync(`git branch ${existingBranch} HEAD`);
		const { config, store, manager } = setup();
		config.defaults.taskIdPrefix = prefix;
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			expect(task.task_id).toBe(`${prefix}-0002`);
		} finally {
			store.close();
			execSync(`git branch -D ${existingBranch}`);
		}
	});

	it("runs an inline task to completion", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ ok: true });
		} finally {
			store.close();
		}
	});

	it("pauses for human input and resumes after respond", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("needs_human"));
			const pending = store.listPendingNeedsHuman()[0];
			expect(pending.task_id).toBe(task.task_id);

			manager.respond(task.task_id, pending.request_id, { decision: "approve" });

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ decision: "approve" });
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — getScript", () => {
	it("returns the script content for a known task", () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			expect(manager.getScript(task.task_id)).toBe(SIMPLE_SCRIPT);
		} finally {
			store.close();
		}
	});

	it("returns null for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getScript("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — getJournal", () => {
	it("returns null for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getJournal("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});

	it("returns empty arrays when journal does not exist yet", () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			// journal.db is created lazily; may not exist immediately after create()
			const entries = manager.getJournal(task.task_id);
			expect(entries).not.toBeNull();
			expect(Array.isArray(entries?.agents)).toBe(true);
			expect(Array.isArray(entries?.humans)).toBe(true);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — getArtifacts", () => {
	it("returns null for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getArtifacts("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});

	it("returns empty array when no artifacts directory exists", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(manager.getArtifacts(task.task_id)).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — rerun", () => {
	it("throws for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(() => manager.rerun("T-9999")).toThrow("Task not found");
		} finally {
			store.close();
		}
	});

	it("creates a new task that runs to completion", async () => {
		const { store, manager } = setup();
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const rerun = manager.rerun(original.task_id);

			expect(rerun.task_id).not.toBe(original.task_id);
			expect(rerun.rerun_of).toBe(original.task_id);

			await vi.waitFor(() => expect(manager.get(rerun.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(rerun.task_id)?.result ?? "null")).toEqual({ ok: true });
		} finally {
			store.close();
		}
	});

	it("copies the journal so cached agent results are reused", async () => {
		const { config, store, manager } = setup();
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const rerun = manager.rerun(original.task_id);
			// The copied journal.db should exist in the new run dir before the run starts
			const copiedJournal = join(config.paths.runsDir, rerun.task_id, "journal.db");
			expect(existsSync(copiedJournal)).toBe(true);

			await vi.waitFor(() => expect(manager.get(rerun.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});

	it("merges option overrides onto the original options", async () => {
		const { store, manager } = setup();
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT, options: { concurrency: 4 } });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const rerun = manager.rerun(original.task_id, { options: { concurrency: 8 } });
			const rerunTask = manager.get(rerun.task_id);
			expect(JSON.parse(rerunTask?.options ?? "{}")).toMatchObject({ concurrency: 8 });

			await vi.waitFor(() => expect(manager.get(rerun.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — iterate", () => {
	it("throws for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(() => manager.iterate("T-9999")).toThrow("Task not found");
		} finally {
			store.close();
		}
	});

	it("creates a new task with a fixed lightweight iterate workflow", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const { store, manager } = setup(undefined, mock.createSession);
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const iter = manager.iterate(original.task_id, { instructions: "improve it" });
			expect(iter.task_id).not.toBe(original.task_id);
			expect(manager.getScript(iter.task_id)).toContain("phase('Refine')");
			expect(manager.getScript(iter.task_id)).toContain("phase('Validate')");
			expect(manager.getScript(iter.task_id)).not.toBe(SIMPLE_SCRIPT);

			await vi.waitFor(() => expect(manager.get(iter.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});

	it("records iteration in task_iterations table", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const { store, manager } = setup(undefined, mock.createSession);
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const iter = manager.iterate(original.task_id, { instructions: "add retry" });
			const iteration = manager.getIteration(iter.task_id);

			expect(iteration.iteration).not.toBeNull();
			expect(iteration.iteration?.parent_task_id).toBe(original.task_id);
			expect(iteration.iteration?.instructions).toBe("add retry");
			expect(iteration.chain).toEqual([original.task_id, iter.task_id]);
		} finally {
			store.close();
		}
	});

	it("iteration chain links multiple iterations", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const { store, manager } = setup(undefined, mock.createSession);
		try {
			const t1 = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(t1.task_id)?.status).toBe("finished"));

			const t2 = manager.iterate(t1.task_id, { instructions: "step 2" });
			await vi.waitFor(() => expect(manager.get(t2.task_id)?.status).toBe("finished"));

			const t3 = manager.iterate(t2.task_id, { instructions: "step 3" });

			const chain = manager.getIteration(t3.task_id).chain;
			expect(chain).toEqual([t1.task_id, t2.task_id, t3.task_id]);
		} finally {
			store.close();
		}
	});

	it("supports iterating a saved task with structured previousResult and reuseBranch", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const { store, manager } = setup(undefined, mock.createSession);
		try {
			manager.putWorkflow(
				"semantic-like",
				"export const meta = { name: 'semantic_like', description: 'Semantic-like result' }\nreturn { status: 'done', analysis: { findings: ['a', 'b'] }, review: { status: 'approved' }, checks: ['typecheck', 'lint'] }",
			);
			const original = manager.create({
				source: "saved",
				workflow_name: "semantic-like",
				options: { cwd: process.cwd(), agent_model: "xiaomi/mimo-v2.5-pro" },
			});
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));
			store.insertWorktree({
				id: `wt-${original.task_id}`,
				task_id: original.task_id,
				label: "implement",
				branch: `kanade/${original.task_id}`,
				base_branch: "main",
				worktree_path: `/tmp/${original.task_id}`,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: Date.now(),
				last_used_at: Date.now(),
				finished_at: Date.now(),
				merge_commit: null,
			});

			expect(() => manager.iterate(original.task_id, { instructions: "refine the API shape" })).not.toThrow();
		} finally {
			store.close();
		}
	});

	it("requires non-empty iterate instructions", async () => {
		const { store, manager } = setup();
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));
			expect(() => manager.iterate(original.task_id, { instructions: "   " })).toThrow("instructions are required");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — create source:saved", () => {
	it("runs a saved workflow by name", async () => {
		const { store, manager } = setup();
		try {
			manager.putWorkflow("demo", SIMPLE_SCRIPT);
			const task = manager.create({ source: "saved", workflow_name: "demo" });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ ok: true });
			expect(manager.get(task.task_id)?.workflow_source).toBe("saved");
			expect(manager.get(task.task_id)?.workflow_name).toBe("demo");
		} finally {
			store.close();
		}
	});

	it("throws for an unknown workflow", () => {
		const { store, manager } = setup();
		try {
			expect(() => manager.create({ source: "saved", workflow_name: "missing" })).toThrow("Workflow not found");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — workflow delegation", () => {
	it("listWorkflows returns empty array initially", () => {
		const { store, manager } = setup();
		try {
			expect(manager.listWorkflows()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("putWorkflow / getWorkflow / deleteWorkflow round-trip", () => {
		const { store, manager } = setup();
		try {
			manager.putWorkflow("demo", SIMPLE_SCRIPT);
			expect(manager.getWorkflow("demo")?.name).toBe("demo");
			expect(manager.deleteWorkflow("demo")).toBe(true);
			expect(manager.getWorkflow("demo")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — save", () => {
	it("throws for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(() => manager.save("T-9999", "my-workflow")).toThrow("Task not found");
		} finally {
			store.close();
		}
	});

	it("throws for an invalid name", () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			expect(() => manager.save(task.task_id, "bad name!")).toThrow();
			expect(() => manager.save(task.task_id, "")).toThrow();
			expect(() => manager.save(task.task_id, "../escape")).toThrow();
		} finally {
			store.close();
		}
	});

	it("writes the script to workflowsDir/<name>.js", async () => {
		const { config, store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			manager.save(task.task_id, "my-workflow");

			const dest = join(config.paths.workflowsDir, "my-workflow.js");
			expect(existsSync(dest)).toBe(true);
			expect(readFileSync(dest, "utf8")).toBe(SIMPLE_SCRIPT);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — create source:generated", () => {
	it("dry-run generates a script without creating or running a task", async () => {
		const generatedScript = "export const meta = { name: 'dry', description: 'Dry' }\nreturn { dry: true }";
		const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "kanade-profile-empty-")));
		const { store, manager } = setup({
			async generate(prompt: string, options?: { model?: string; workspaceRoot?: string }) {
				expect(prompt).toBe("make workflow");
				expect(options?.model).toBe("gpt-5.4");
				expect(options?.workspaceRoot).toBe(workspaceRoot);
				return generatedScript;
			},
		});
		try {
			const result = await manager.generateWorkflow("make workflow", {
				author_model: "gpt-5.4",
				cwd: workspaceRoot,
			});
			expect(result.script).toBe(generatedScript);
			expect(manager.list()).toHaveLength(0);
		} finally {
			rmSync(workspaceRoot, { recursive: true, force: true });
			store.close();
		}
	});

	it("passes rendered project profile context to workflow author without real LLM execution", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "kanade-profile-root-"));
		const workspaceRoot = realpathSync(projectRoot);
		writeFileSync(join(projectRoot, "pom.xml"), "<project></project>");
		writeFileSync(join(projectRoot, "mvnw"), "echo mvnw");
		mkdirSync(join(projectRoot, "src/main/java"), { recursive: true });
		let capturedProfilePrompt = "";
		const generatedScript = "export const meta = { name: 'dry', description: 'Dry' }\nreturn { ok: true }";
		const { store, manager } = setup({
			async generate(prompt: string, options?: { model?: string; workspaceRoot?: string }) {
				expect(options?.workspaceRoot).toBe(workspaceRoot);
				capturedProfilePrompt = buildWorkflowAuthorPrompt(prompt, {
					projectProfile: detectProjectProfile(options?.workspaceRoot ?? process.cwd()),
				});
				return generatedScript;
			},
		});
		try {
			const task = manager.create({ source: "generated", prompt: "add maven docs", options: { cwd: workspaceRoot } });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"), {
				timeout: 5000,
			});
			expect(capturedProfilePrompt).toContain("Workspace profile snapshot");
			expect(capturedProfilePrompt).toContain("java-maven");
			expect(capturedProfilePrompt).toContain("./mvnw test");
			const row = manager.get(task.task_id);
			expect(row?.status).toBe("finished");
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
			store.close();
		}
	});

	it("generates a script, writes it to workflow.js, and runs to completion", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "generated",
				prompt: "return { generated: true }",
			});
			expect(task.generated).toBe(true);
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).not.toBe("created"), {
				timeout: 5000,
			});
			// workflow.js must exist immediately after script generation
			expect(existsSync(task.workflow_path)).toBe(true);
		} finally {
			store.close();
		}
	});

	it("emits task.script_generated before task.running", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({ source: "generated", prompt: "return {}" });
			await vi.waitFor(() => expect(emitted).toContain("task.script_generated"), { timeout: 5000 });

			const scriptIdx = emitted.indexOf("task.script_generated");
			const runningIdx = emitted.indexOf("task.running");
			if (runningIdx !== -1) expect(scriptIdx).toBeLessThan(runningIdx);

			await manager.abort(task.task_id);
		} finally {
			store.close();
		}
	});

	it("uses injected author to avoid real LLM calls in tests", async () => {
		const { store, manager } = setup();
		try {
			// The default author is a stub that echoes the prompt as a minimal script.
			// Real LLM author is only used when pi SDK is configured.
			const task = manager.create({ source: "generated", prompt: "return { ok: true }" });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"), {
				timeout: 5000,
			});
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toMatchObject({ ok: true });
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — abort", () => {
	it("sets status to aborted and emits task.aborted", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({
				source: "inline",
				script:
					"export const meta = { name: 'slow', description: 'Slow' }\nreturn await request_human({ title: 'wait' })",
			});
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("needs_human"));

			await manager.abort(task.task_id);

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("aborted"));
			expect(manager.get(task.task_id)?.finished_at).toBeTruthy();
			expect(emitted).toContain("task.aborted");
		} finally {
			store.close();
		}
	});

	it("abort is idempotent for unknown tasks", () => {
		const { store, manager } = setup();
		try {
			// Should not throw
			void manager.abort("T-9999");
		} finally {
			store.close();
		}
	});

	it("abort while task is running propagates signal", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("needs_human"));

			await manager.abort(task.task_id);

			// Task should eventually be aborted after the workflow unwinds and cleanup completes.
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("aborted"));
			expect(manager.get(task.task_id)?.finished_at).toBeTruthy();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — task failure", () => {
	it("sets status to failed when script throws", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({
				source: "inline",
				script: "export const meta = { name: 'fail', description: 'Fail' }\nthrow new Error('intentional failure')",
			});

			await vi.waitFor(() => {
				const t = manager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(manager.get(task.task_id)?.error).toContain("intentional failure");
			expect(manager.get(task.task_id)?.finished_at).toBeTruthy();
			expect(emitted).toContain("task.failed");
		} finally {
			store.close();
		}
	});

	it("sets status to failed when script has syntax error", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script: "export const meta = { name: 'bad', description: 'Bad' }\n{{{invalid syntax!!!",
			});

			await vi.waitFor(() => {
				const t = manager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(manager.get(task.task_id)?.error).toBeTruthy();
		} finally {
			store.close();
		}
	});

	it("sets status to failed when script has no meta export", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script: "return { ok: true }",
			});

			await vi.waitFor(() => {
				const t = manager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(manager.get(task.task_id)?.error).toContain("meta");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — lifecycle events", () => {
	it("emits task.created then task.running then task.finished in order", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			const createdIdx = emitted.indexOf("task.created");
			const runningIdx = emitted.indexOf("task.running");
			const finishedIdx = emitted.indexOf("task.finished");

			expect(createdIdx).toBeGreaterThanOrEqual(0);
			expect(runningIdx).toBeGreaterThan(createdIdx);
			expect(finishedIdx).toBeGreaterThan(runningIdx);
		} finally {
			store.close();
		}
	});

	it("emits workflow.phase events during execution", async () => {
		const { store, events, manager } = setup();
		try {
			const phases: string[] = [];
			events.onAny((e) => {
				if (e.type === "workflow.phase") phases.push((e.data as { phase: string }).phase);
			});

			const script = `
				export const meta = { name: 'phased', description: 'Phased', phases: [{ title: 'Build' }] }
				phase('Build')
				return { done: true }
			`;
			const task = manager.create({ source: "inline", script });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			expect(phases).toContain("Build");
		} finally {
			store.close();
		}
	});

	it("emits workflow.log events", async () => {
		const { store, events, manager } = setup();
		try {
			const logs: string[] = [];
			events.onAny((e) => {
				if (e.type === "workflow.log") logs.push((e.data as { message: string }).message);
			});

			const script = `
				export const meta = { name: 'logger', description: 'Logger' }
				log('hello from workflow')
				return { done: true }
			`;
			const task = manager.create({ source: "inline", script });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			expect(logs).toContain("hello from workflow");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — journal persistence", () => {
	it("creates journal.db after task completes", async () => {
		const { config, store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			const journalPath = join(config.paths.runsDir, task.task_id, "journal.db");
			expect(existsSync(journalPath)).toBe(true);

			// getJournal should return entries
			const entries = manager.getJournal(task.task_id);
			expect(entries).not.toBeNull();
		} finally {
			store.close();
		}
	});

	it("getJournal returns null for a task that never ran", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getJournal("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — generated workflow failure", () => {
	it("sets status to failed when author.generate() throws", async () => {
		const { store, events, manager: _manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			// Inject an author that always fails
			const failManager = new (await import("./task-manager.ts")).TaskManager(
				(await import("../config/index.ts")).loadConfig(),
				store,
				events,
				new (await import("../human/index.ts")).HumanGate(store, { initialPollMs: 5 }),
				{
					async generate() {
						throw new Error("LLM unavailable");
					},
				},
			);

			const task = failManager.create({ source: "generated", prompt: "test" });
			expect(task.generated).toBe(true);

			await vi.waitFor(() => {
				const t = failManager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(failManager.get(task.task_id)?.error).toContain("LLM unavailable");
			expect(emitted).toContain("task.failed");
		} finally {
			store.close();
		}
	});

	it("fails fast when generated script violates semantic workflow rules", async () => {
		const { store, events } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const failManager = new (await import("./task-manager.ts")).TaskManager(
				(await import("../config/index.ts")).loadConfig(),
				store,
				events,
				new (await import("../human/index.ts")).HumanGate(store, { initialPollMs: 5 }),
				{
					async generate() {
						return "export const meta = { name: 'bad_generated', description: 'Bad generated' }\nreturn await agent('do it', { label: 'x' })";
					},
				},
			);

			const task = failManager.create({ source: "generated", prompt: "test" });
			await vi.waitFor(() => {
				const row = failManager.get(task.task_id);
				expect(row?.status).toBe("failed");
			});

			expect(failManager.get(task.task_id)?.error).toContain("Semantic workflow validation failed");
			expect(failManager.get(task.task_id)?.error).toContain("raw agent()");
			expect(emitted).not.toContain("task.running");
			expect(failManager.getWorktrees(task.task_id)).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("emits task.script_generated before run starts for successful generation", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: Array<{ type: string; data: unknown }> = [];
			events.onAny((e) => emitted.push({ type: e.type, data: e.data }));

			const task = manager.create({ source: "generated", prompt: "return { ok: true }" });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"), {
				timeout: 5000,
			});

			const scriptGenIdx = emitted.findIndex((e) => e.type === "task.script_generated");
			const runningIdx = emitted.findIndex((e) => e.type === "task.running");
			expect(scriptGenIdx).toBeGreaterThanOrEqual(0);
			expect(runningIdx).toBeGreaterThan(scriptGenIdx);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — task metadata", () => {
	it("stores resolved base repo and branch in task row", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const row = manager.get(task.task_id);
			expect(row?.base_repo).toBe(process.cwd());
			expect(row?.base_branch).toBe(currentBranch());
			expect(row?.workflow_source).toBe("inline");
			expect(row?.created_at).toBeTruthy();
		} finally {
			store.close();
		}
	});

	it("uses options.cwd git repo and branch for inline task base metadata", () => {
		const { repo, child } = createTemporaryGitRepo();
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT, options: { cwd: child } });
			const row = manager.get(task.task_id);
			expect(row?.base_repo).toBe(repo);
			expect(row?.base_branch).toBe("feature/test-branch");
			expect(row?.workflow_source).toBe("inline");
		} finally {
			store.close();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("uses options.cwd git repo and branch for generated task base metadata", () => {
		const { repo, child } = createTemporaryGitRepo();
		const { store, manager } = setup({ generate: async () => SIMPLE_SCRIPT });
		try {
			const task = manager.create({ source: "generated", prompt: "do it", options: { cwd: child } });
			const row = manager.get(task.task_id);
			expect(row?.base_repo).toBe(repo);
			expect(row?.base_branch).toBe("feature/test-branch");
			expect(row?.workflow_source).toBe("generated");
		} finally {
			store.close();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("uses options.cwd git repo and branch for saved task base metadata", () => {
		const { repo, child } = createTemporaryGitRepo();
		const { store, manager } = setup();
		try {
			const sourceTask = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			manager.save(sourceTask.task_id, "base-cwd-test");
			const task = manager.create({ source: "saved", workflow_name: "base-cwd-test", options: { cwd: child } });
			const row = manager.get(task.task_id);
			expect(row?.base_repo).toBe(repo);
			expect(row?.base_branch).toBe("feature/test-branch");
			expect(row?.workflow_source).toBe("saved");
		} finally {
			store.close();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("falls back to process.cwd when options.cwd is not a git repo", () => {
		const nonGitDir = realpathSync(mkdtempSync(join(tmpdir(), "kanade-non-git-")));
		const { config, store, manager } = setup();
		config.isolation.defaultBaseRepo = null;
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT, options: { cwd: nonGitDir } });
			const row = manager.get(task.task_id);
			expect(row?.base_repo).toBe(realpathSync(process.cwd()));
			expect(row?.base_branch).toBe(currentBranch());
		} finally {
			store.close();
			rmSync(nonGitDir, { recursive: true, force: true });
		}
	});

	it("stores options as JSON string", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script: SIMPLE_SCRIPT,
				options: { concurrency: 4, author_model: "author-model", agent_model: "agent-model" },
			});
			const row = manager.get(task.task_id);
			const opts = JSON.parse(row?.options ?? "{}");
			expect(opts.concurrency).toBe(4);
			expect(opts.author_model).toBe("author-model");
			expect(opts.agent_model).toBe("agent-model");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — list", () => {
	it("lists all tasks", async () => {
		const { store, manager } = setup();
		try {
			manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => {
				const all = manager.list();
				expect(all.length).toBeGreaterThanOrEqual(2);
			});
		} finally {
			store.close();
		}
	});

	it("filters tasks by status", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			const finished = manager.list("finished");
			expect(finished.some((t) => t.id === task.task_id)).toBe(true);

			const running = manager.list("running");
			expect(running.some((t) => t.id === task.task_id)).toBe(false);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — getUsage", () => {
	it("returns null for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getUsage("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});

	it("returns parsed persisted task usage", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			store.updateTask(task.task_id, {
				usage: JSON.stringify({
					input: 12,
					output: 34,
					cacheRead: 5,
					cacheWrite: 6,
					totalTokens: 57,
					cost: { input: 0.0012, output: 0.0034, cacheRead: 0.0005, cacheWrite: 0.0006, total: 0.0057 },
				}),
			});

			expect(manager.getUsage(task.task_id)).toEqual({
				input: 12,
				output: 34,
				cacheRead: 5,
				cacheWrite: 6,
				totalTokens: 57,
				cost: { input: 0.0012, output: 0.0034, cacheRead: 0.0005, cacheWrite: 0.0006, total: 0.0057 },
			});
		} finally {
			store.close();
		}
	});
});
