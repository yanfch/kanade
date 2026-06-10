/**
 * Path constants and config loading.
 * All paths derive from KANADE_DIR (default ~/.kanade).
 * Override via env vars for testing.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

export interface KanadePaths {
	readonly root: string;
	readonly configFile: string;
	readonly dbDir: string;
	readonly rolesDir: string;
	readonly workflowsDir: string;
	readonly sharedExtensionsDir: string;
	readonly runsDir: string;
	readonly worktreesDir: string;
	readonly tracesDir: string;
	readonly stateDb: string;
	readonly logsDir: string;
}

export interface ServerConfig {
	port: number;
	bind: string;
}

export interface IsolationConfig {
	defaultMode: "none" | "worktree";
	defaultBaseBranch: string;
	defaultBaseRepo: string | null;
	worktreeBaseDir: string;
	branchPrefix: string;
	autoCleanupOnReject: boolean;
	autoCleanupOnApprove: boolean;
	autoCleanupOnAbort: boolean;
	staleAfterDays: number;
	maxConcurrent: number;
}

export interface MergeConfig {
	targetBranch: string;
	useNoFf: boolean;
	requireCleanLint: boolean;
	requireCleanTest: boolean;
	deleteBranchAfterMerge: boolean;
	allowSkipReview: boolean;
}

export interface TracingExporterConfig {
	type: "file" | "console" | "otlp_http";
	dir?: string;
	logDir?: string;
	rotate?: "daily" | "hourly" | "none";
	endpoint?: string;
	headers?: Record<string, string>;
}

export interface TracingSamplingConfig {
	rate: number;
	alwaysSample: string[];
	logErrorRate: number;
	logInfoRate: number;
	logDebugRate: number;
}

export interface TracingConfig {
	enabled: boolean;
	serviceName: string;
	/** @deprecated Use exporters array instead */
	exporter: TracingExporterConfig;
	exporters?: TracingExporterConfig[];
	sampling?: TracingSamplingConfig;
	captureContent?: boolean;
}

export interface DefaultsConfig {
	model: string | null;
	tokenBudget: number;
	/** Per-task cost limit in USD. Task pauses when exceeded. */
	costBudget: number;
	/** Daily total cost limit in USD across all tasks. */
	dailyCostBudget: number;
	/** Task ID prefix. Default: "T". Tests use "X" to avoid collisions. */
	taskIdPrefix?: string;
	/** Per-agent timeout in milliseconds. 0 disables timeout. */
	agentTimeoutMs: number;
	concurrency: number;
	/** Maximum number of tasks running simultaneously. 0 = unlimited. */
	maxConcurrentTasks: number;
}

export interface ModelsConfig {
	mode: "inherit-pi" | "kanade";
	piAgentDir: string | null;
	agentDir: string | null;
	authPath: string | null;
	modelsPath: string | null;
	inheritPiSettings: boolean;
	disableSubagentCompaction: boolean;
}

export interface DebugConfig {
	persistSubagents: boolean;
	persistFilter: PersistFilter | null;
	dumpArtifacts: boolean;
}

export interface PersistFilter {
	roles?: string[];
	phases?: string[];
	labels?: string[];
}

export interface AnnouncerConfig {
	name: string;
	type: "http_post" | "macos_notification" | "tts_local";
	/** URL for http_post type */
	url?: string;
	/** Events to listen for (e.g. task.finished, task.needs_human) */
	events: string[];
	/** Template for notification title. Supports {{task.id}}, {{event.summary}} */
	title_template?: string;
	/** Template for notification body */
	body_template?: string;
	/** true = always on, false = disabled, "auto" = probe health on startup */
	enabled: boolean | "auto";
	/** Name of fallback announcer if this one fails */
	fallback?: string;
	/** Timeout for http_post requests (ms). Default: 5000 */
	timeout_ms?: number;
}

export interface CleanupConfig {
	enabled: boolean;
	schedule: string;
	journalRetentionDays: number;
	traceRetentionDays: number;
}

export interface KanadeConfig {
	paths: KanadePaths;
	server: ServerConfig;
	isolation: IsolationConfig;
	merge: MergeConfig;
	tracing: TracingConfig;
	defaults: DefaultsConfig;
	models: ModelsConfig;
	debug: DebugConfig;
	cleanup: CleanupConfig;
	announcers: AnnouncerConfig[];
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	if (p === "~") return homedir();
	return p;
}

function getPathEnv(name: string): string | undefined {
	const value = process.env[name];
	if (!value || value === "undefined" || value === "null") return undefined;
	return value;
}

function getKanadeDir(): string {
	const fromEnv = getPathEnv("KANADE_DIR");
	if (fromEnv) return resolve(expandHome(fromEnv));
	return join(homedir(), ".kanade");
}

function buildPaths(root: string): KanadePaths {
	return {
		root,
		configFile: join(root, "config.yml"),
		dbDir: join(root, "db"),
		rolesDir: join(root, "roles"),
		workflowsDir: join(root, "workflows"),
		sharedExtensionsDir: join(root, "shared", "extensions"),
		runsDir: join(root, "runs"),
		worktreesDir: join(root, "worktrees"),
		tracesDir: getPathEnv("KANADE_TRACES_DIR") ?? join(root, "traces"),
		stateDb: join(root, "db", "state.db"),
		logsDir: join(root, "logs"),
	};
}

function defaultConfig(paths: KanadePaths): KanadeConfig {
	return {
		paths,
		server: {
			port: 7777,
			bind: "127.0.0.1",
		},
		isolation: {
			defaultMode: "worktree",
			defaultBaseBranch: "main",
			defaultBaseRepo: null,
			worktreeBaseDir: paths.worktreesDir,
			branchPrefix: "kanade",
			autoCleanupOnReject: true,
			autoCleanupOnApprove: false,
			autoCleanupOnAbort: true,
			staleAfterDays: 7,
			maxConcurrent: 16,
		},
		merge: {
			targetBranch: "main",
			useNoFf: true,
			requireCleanLint: true,
			requireCleanTest: true,
			deleteBranchAfterMerge: true,
			allowSkipReview: false,
		},
		tracing: {
			enabled: true,
			serviceName: "kanade",
			exporter: {
				type: "file",
				dir: paths.tracesDir,
				logDir: paths.logsDir,
				rotate: "daily",
			},
			sampling: {
				rate: 1.0,
				alwaysSample: ["workflow.task", "workflow.author", "human.request"],
				logErrorRate: 1.0,
				logInfoRate: 1.0,
				logDebugRate: 0.0,
			},
			captureContent: false,
		},
		defaults: {
			model: null,
			tokenBudget: 2_000_000,
			costBudget: 5.0,
			dailyCostBudget: 100.0,
			agentTimeoutMs: 10 * 60 * 1000,
			concurrency: 16,
			maxConcurrentTasks: 0,
		},
		models: {
			mode: "inherit-pi",
			piAgentDir: null,
			agentDir: null,
			authPath: null,
			modelsPath: null,
			inheritPiSettings: true,
			disableSubagentCompaction: true,
		},
		debug: {
			persistSubagents: false,
			persistFilter: null,
			dumpArtifacts: false,
		},
		cleanup: {
			enabled: true,
			schedule: "0 * * * *",
			journalRetentionDays: 30,
			traceRetentionDays: 90,
		},
		announcers: [],
	};
}

function deepMerge<T>(base: T, overrides: Partial<T> | undefined): T {
	if (!overrides) return base;
	const result = { ...base } as T;
	for (const [key, value] of Object.entries(overrides) as [keyof T, unknown][]) {
		if (value === undefined) continue;
		const baseValue = (base as Record<string, unknown>)[key as string];
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			baseValue !== null &&
			typeof baseValue === "object" &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key as string] = deepMerge(baseValue, value as Record<string, unknown>);
		} else {
			(result as Record<string, unknown>)[key as string] = value;
		}
	}
	return result;
}

export function loadConfig(): KanadeConfig {
	const root = getKanadeDir();
	const paths = buildPaths(root);

	// Ensure root + key subdirs exist
	for (const dir of [
		root,
		paths.dbDir,
		paths.rolesDir,
		paths.workflowsDir,
		paths.runsDir,
		paths.worktreesDir,
		paths.tracesDir,
		paths.logsDir,
		dirname(paths.sharedExtensionsDir),
	]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	let userConfig: Partial<KanadeConfig> = {};
	if (existsSync(paths.configFile)) {
		try {
			const raw = readFileSync(paths.configFile, "utf8");
			userConfig = YAML.parse(raw) ?? {};
		} catch (err) {
			throw new Error(`Failed to parse ${paths.configFile}: ${(err as Error).message}`);
		}
	}

	const base = defaultConfig(paths);
	const merged = deepMerge(base, userConfig);
	merged.paths = paths;

	return merged;
}
