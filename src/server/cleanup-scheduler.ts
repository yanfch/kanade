/**
 * CleanupScheduler — background periodic cleanup of stale worktrees,
 * expired journal files, and old trace directories.
 *
 * Runs on a configurable schedule (default: every hour).
 * Each cleanup task is independent — a failure in one does not block others.
 */

import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CleanupConfig, KanadePaths } from "../config/config.ts";

const MS_PER_DAY = 86_400_000;

export interface CleanupResult {
	worktreesCleaned: number;
	journalsCleaned: number;
	tracesCleaned: number;
	errors: string[];
	durationMs: number;
}

interface CleanupSchedulerLogger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string, err?: unknown): void;
}

export interface CleanupSchedulerDeps {
	config: CleanupConfig;
	paths: KanadePaths;
	isolation: { cleanupStaleWorktrees(beforeTs: number): Promise<void> };
	logger: CleanupSchedulerLogger;
}

/** Parse a simple cron schedule string to milliseconds. Supports hourly and every-N-minutes patterns. */
export function parseScheduleToMs(schedule: string): number {
	const parts = schedule.split(" ");
	if (parts.length >= 2 && parts[1] === "*") {
		const minute = parts[0];
		if (minute.startsWith("*/")) {
			const n = Number.parseInt(minute.slice(2), 10);
			if (n > 0) return n * 60_000;
		}
		if (minute === "0") return 3_600_000; // hourly on the hour
	}
	return 3_600_000; // default 1 hour
}

export class CleanupScheduler {
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private startupTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly deps: CleanupSchedulerDeps) {}

	start(): void {
		if (!this.deps.config.enabled) {
			this.deps.logger.info("cleanup scheduler disabled");
			return;
		}
		const ms = parseScheduleToMs(this.deps.config.schedule);
		this.deps.logger.info(`cleanup scheduler started (interval: ${ms}ms, schedule: ${this.deps.config.schedule})`);
		this.intervalId = setInterval(() => void this.run(), ms);
		// Run once shortly after startup
		this.startupTimer = setTimeout(() => void this.run(), 5_000);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.startupTimer) {
			clearTimeout(this.startupTimer);
			this.startupTimer = null;
		}
	}

	async run(): Promise<CleanupResult> {
		const started = Date.now();
		const result: CleanupResult = {
			worktreesCleaned: 0,
			journalsCleaned: 0,
			tracesCleaned: 0,
			errors: [],
			durationMs: 0,
		};

		this.deps.logger.info("cleanup cycle started");

		// 1. Stale worktrees
		try {
			const staleBefore = Date.now() - 7 * MS_PER_DAY; // TODO: use config.isolation.staleAfterDays
			await this.deps.isolation.cleanupStaleWorktrees(staleBefore);
			result.worktreesCleaned++; // count is approximate — cleanupStaleWorktrees doesn't return count
		} catch (err) {
			const msg = `worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
			result.errors.push(msg);
			this.deps.logger.error(msg);
		}

		// 2. Old journal files
		try {
			result.journalsCleaned = this.cleanExpiredJournals();
		} catch (err) {
			const msg = `journal cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
			result.errors.push(msg);
			this.deps.logger.error(msg);
		}

		// 3. Old trace directories
		try {
			result.tracesCleaned = this.cleanExpiredTraces();
		} catch (err) {
			const msg = `trace cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
			result.errors.push(msg);
			this.deps.logger.error(msg);
		}

		result.durationMs = Date.now() - started;
		this.deps.logger.info(
			`cleanup cycle done: worktrees=${result.worktreesCleaned}, journals=${result.journalsCleaned}, ` +
				`traces=${result.tracesCleaned}, errors=${result.errors.length}, duration=${result.durationMs}ms`,
		);
		return result;
	}

	private cleanExpiredJournals(): number {
		const { runsDir } = this.deps.paths;
		const retentionMs = this.deps.config.journalRetentionDays * MS_PER_DAY;
		const cutoff = Date.now() - retentionMs;
		let cleaned = 0;

		if (!existsSync(runsDir)) return 0;

		for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const journalPath = join(runsDir, entry.name, "journal.db");
			if (!existsSync(journalPath)) continue;
			try {
				const stat = statSync(journalPath);
				if (stat.mtimeMs < cutoff) {
					unlinkSync(journalPath);
					cleaned++;
				}
			} catch {
				// best effort — skip files we can't stat/delete
			}
		}
		return cleaned;
	}

	private cleanExpiredTraces(): number {
		const { tracesDir } = this.deps.paths;
		const retentionMs = this.deps.config.traceRetentionDays * MS_PER_DAY;
		const cutoff = Date.now() - retentionMs;
		let cleaned = 0;

		if (!existsSync(tracesDir)) return 0;

		for (const entry of readdirSync(tracesDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const name = entry.name;
			// Skip non-date directories (e.g., "current" symlink/file)
			if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
			const dirDate = new Date(`${name}T00:00:00Z`);
			if (Number.isNaN(dirDate.getTime())) continue;
			if (dirDate.getTime() < cutoff) {
				try {
					rmSync(join(tracesDir, name), { recursive: true, force: true });
					cleaned++;
				} catch {
					// best effort
				}
			}
		}
		return cleaned;
	}
}
