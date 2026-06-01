import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupConfig, KanadePaths } from "../config/config.ts";
import { CleanupScheduler, parseScheduleToMs } from "./cleanup-scheduler.ts";

function createTestDir(): string {
	return mkdtempSync(join(tmpdir(), "kanade-cleanup-test-"));
}

function createMockLogger() {
	const messages: Array<{ level: string; msg: string }> = [];
	return {
		info: (msg: string) => messages.push({ level: "info", msg }),
		warn: (msg: string) => messages.push({ level: "warn", msg }),
		error: (msg: string, err?: unknown) => messages.push({ level: "error", msg: err ? `${msg}: ${err}` : msg }),
		messages,
	};
}

describe("parseScheduleToMs", () => {
	it('parses "0 * * * *" as 1 hour', () => {
		expect(parseScheduleToMs("0 * * * *")).toBe(3_600_000);
	});

	it('parses "*/5 * * * *" as 5 minutes', () => {
		expect(parseScheduleToMs("*/5 * * * *")).toBe(300_000);
	});

	it('parses "*/30 * * * *" as 30 minutes', () => {
		expect(parseScheduleToMs("*/30 * * * *")).toBe(1_800_000);
	});

	it("defaults to 1 hour for unrecognized patterns", () => {
		expect(parseScheduleToMs("0 0 * * *")).toBe(3_600_000);
		expect(parseScheduleToMs("invalid")).toBe(3_600_000);
	});
});

describe("CleanupScheduler", () => {
	let root: string;
	let paths: KanadePaths;
	let config: CleanupConfig;

	beforeEach(() => {
		vi.useFakeTimers();
		root = createTestDir();
		paths = {
			root,
			configFile: join(root, "config.yml"),
			dbDir: join(root, "db"),
			rolesDir: join(root, "roles"),
			workflowsDir: join(root, "workflows"),
			sharedExtensionsDir: join(root, "shared", "extensions"),
			runsDir: join(root, "runs"),
			worktreesDir: join(root, "worktrees"),
			tracesDir: join(root, "traces"),
			stateDb: join(root, "db", "state.db"),
			logsDir: join(root, "logs"),
		};
		for (const dir of [paths.runsDir, paths.worktreesDir, paths.tracesDir, paths.logsDir, paths.dbDir]) {
			mkdirSync(dir, { recursive: true });
		}
		config = {
			enabled: true,
			schedule: "0 * * * *",
			journalRetentionDays: 30,
			traceRetentionDays: 90,
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("does not start when enabled is false", () => {
		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config: { ...config, enabled: false },
			paths,
			isolation: { cleanupStaleWorktrees: vi.fn() },
			logger: logger as never,
		});

		scheduler.start();
		// No interval should be set
		expect(logger.messages.some((m) => m.msg.includes("disabled"))).toBe(true);
		scheduler.stop();
	});

	it("logs schedule on start", () => {
		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config,
			paths,
			isolation: { cleanupStaleWorktrees: vi.fn() },
			logger: logger as never,
		});

		scheduler.start();
		expect(logger.messages.some((m) => m.msg.includes("started"))).toBe(true);
		scheduler.stop();
	});

	it("stop() clears the interval", () => {
		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config,
			paths,
			isolation: { cleanupStaleWorktrees: vi.fn() },
			logger: logger as never,
		});

		scheduler.start();
		scheduler.stop();
		// Advancing time should not trigger any runs
		vi.advanceTimersByTime(3_600_000 * 5);
		expect(logger.messages.filter((m) => m.msg.includes("cleanup cycle")).length).toBeLessThanOrEqual(1); // only the startup run
	});

	it("run() calls cleanupStaleWorktrees with correct timestamp", async () => {
		const cleanupStaleWorktrees = vi.fn().mockResolvedValue(undefined);
		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config: { ...config, journalRetentionDays: 30, traceRetentionDays: 90 },
			paths,
			isolation: { cleanupStaleWorktrees },
			logger: logger as never,
		});

		const now = new Date("2026-06-01T12:00:00Z").getTime();
		vi.setSystemTime(now);

		const result = await scheduler.run();

		expect(cleanupStaleWorktrees).toHaveBeenCalledTimes(1);
		const calledWith = cleanupStaleWorktrees.mock.calls[0][0];
		// Should be ~7 days before now (default staleAfterDays)
		const expectedStale = now - 7 * 86400_000;
		expect(Math.abs(calledWith - expectedStale)).toBeLessThan(1000);
		expect(result.worktreesCleaned).toBeGreaterThanOrEqual(0);
	});

	it("run() deletes expired journal.db files", async () => {
		// Create some run directories with journal.db
		const t1 = join(paths.runsDir, "T-0001");
		const t2 = join(paths.runsDir, "T-0002");
		const t3 = join(paths.runsDir, "T-0003");
		mkdirSync(t1, { recursive: true });
		mkdirSync(t2, { recursive: true });
		mkdirSync(t3, { recursive: true });
		writeFileSync(join(t1, "journal.db"), "old");
		writeFileSync(join(t2, "journal.db"), "recent");
		writeFileSync(join(t3, "workflow.js"), "no journal");

		// Set mtime of T-0001's journal to 60 days ago
		const now = Date.now();
		vi.setSystemTime(now);
		const oldTime = new Date(now - 60 * 86400_000);
		utimesSync(join(t1, "journal.db"), oldTime, oldTime);

		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config: { ...config, journalRetentionDays: 30 },
			paths,
			isolation: { cleanupStaleWorktrees: vi.fn() },
			logger: logger as never,
		});

		const result = await scheduler.run();

		// T-0001 is 60 days old (>30 retention) → deleted
		expect(existsSync(join(t1, "journal.db"))).toBe(false);
		// T-0002 is fresh (<30 retention) → kept
		expect(existsSync(join(t2, "journal.db"))).toBe(true);
		// T-0003 has no journal.db, should be unaffected
		expect(existsSync(join(t3, "workflow.js"))).toBe(true);
		expect(result.journalsCleaned).toBe(1);
	});

	it("run() deletes expired trace directories", async () => {
		// Create trace directories with date names
		const oldDir = join(paths.tracesDir, "2026-03-01");
		const recentDir = join(paths.tracesDir, "2026-05-25");
		const currentFile = join(paths.tracesDir, "current");
		mkdirSync(oldDir, { recursive: true });
		mkdirSync(recentDir, { recursive: true });
		writeFileSync(join(oldDir, "kanade.jsonl"), "old spans");
		writeFileSync(join(recentDir, "kanade.jsonl"), "recent spans");
		writeFileSync(currentFile, "2026-05-25");

		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config: { ...config, traceRetentionDays: 30 },
			paths,
			isolation: { cleanupStaleWorktrees: vi.fn() },
			logger: logger as never,
		});

		// Set system time to 2026-06-01
		vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));

		const result = await scheduler.run();

		// 2026-03-01 is >30 days before 2026-06-01 → deleted
		expect(existsSync(oldDir)).toBe(false);
		// 2026-05-25 is <30 days before 2026-06-01 → kept
		expect(existsSync(recentDir)).toBe(true);
		// current file should be kept (not a date directory)
		expect(existsSync(currentFile)).toBe(true);
		expect(result.tracesCleaned).toBe(1);
	});

	it("run() skips current symlink/file in traces", async () => {
		const currentFile = join(paths.tracesDir, "current");
		const currentDir = join(paths.tracesDir, "2020-01-01"); // very old
		mkdirSync(currentDir, { recursive: true });
		writeFileSync(currentFile, "2026-05-31");

		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config: { ...config, traceRetentionDays: 30 },
			paths,
			isolation: { cleanupStaleWorktrees: vi.fn() },
			logger: logger as never,
		});

		vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
		await scheduler.run();

		// current should never be deleted
		expect(existsSync(currentFile)).toBe(true);
	});

	it("run() continues even if one cleanup task fails", async () => {
		const cleanupStaleWorktrees = vi.fn().mockRejectedValue(new Error("git broken"));
		const logger = createMockLogger();

		// Create an expired journal (60 days old)
		const t1 = join(paths.runsDir, "T-0001");
		mkdirSync(t1, { recursive: true });
		writeFileSync(join(t1, "journal.db"), "old");
		const oldTime = new Date(Date.now() - 60 * 86400_000);
		utimesSync(join(t1, "journal.db"), oldTime, oldTime);

		const scheduler = new CleanupScheduler({
			config: { ...config, journalRetentionDays: 30 },
			paths,
			isolation: { cleanupStaleWorktrees },
			logger: logger as never,
		});

		const result = await scheduler.run();

		// Worktree cleanup failed, but journal cleanup should still run
		expect(result.errors.length).toBeGreaterThanOrEqual(1);
		expect(existsSync(join(t1, "journal.db"))).toBe(false);
		expect(result.journalsCleaned).toBe(1);
	});

	it("run() returns a result summary", async () => {
		const logger = createMockLogger();
		const scheduler = new CleanupScheduler({
			config,
			paths,
			isolation: { cleanupStaleWorktrees: vi.fn() },
			logger: logger as never,
		});

		const result = await scheduler.run();

		expect(result).toHaveProperty("worktreesCleaned");
		expect(result).toHaveProperty("journalsCleaned");
		expect(result).toHaveProperty("tracesCleaned");
		expect(result).toHaveProperty("errors");
		expect(result).toHaveProperty("durationMs");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});
