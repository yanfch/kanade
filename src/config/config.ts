/**
 * Path constants and config loading.
 * All paths derive from KANADE_DIR (default ~/.kanade).
 * Override via env vars for testing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
	prepareCommands?: string[];
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
	/** Default model for generated workflow authoring. */
	authorModel: string | null;
	/** Default model for workflow subagents. */
	agentModel: string | null;
	/** Per-role default subagent model overrides. */
	roleModels: Record<string, string>;
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
	/** `"pi"` is accepted as a backwards-compatible alias for `"inherit-pi"`. */
	mode: "inherit-pi" | "kanade" | "pi";
	piAgentDir: string | null;
	agentDir: string | null;
	authPath: string | null;
	modelsPath: string | null;
	inheritPiSettings: boolean;
	disableSubagentCompaction: boolean;
}

export interface NetworkConfig {
	/** HTTP proxy used by server-side fetch/LLM SDK requests when env vars are not set. */
	httpProxy: string | null;
	/** HTTPS proxy used by server-side fetch/LLM SDK requests when env vars are not set. */
	httpsProxy: string | null;
	/** Fallback proxy used by server-side fetch/LLM SDK requests when env vars are not set. */
	allProxy: string | null;
	/** Comma-separated hosts that should bypass proxy. */
	noProxy: string | null;
	/** Undici body/header idle timeout in milliseconds. */
	httpIdleTimeoutMs: number;
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
	type: "http_post" | "macos_notification" | "tts_local" | "tsutae_tts";
	/** URL for http_post, or Tsutae /v1/speak URL for tsutae_tts. */
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
	/** Timeout for http_post/tsutae_tts requests (ms). Default: 5000 */
	timeout_ms?: number;
	/** Tsutae TTS source label. Default: "kanade". */
	source?: string;
	/** Tsutae TTS voice override. */
	voice?: string;
	/** Tsutae TTS rate override. */
	rate?: number;
	/** Interrupt current Tsutae playback. Default: true. */
	interrupt?: boolean;
	/** Tsutae speaking UI style. */
	presentationStyle?: "standard" | "minimal";
}

export interface CleanupConfig {
	enabled: boolean;
	schedule: string;
	journalRetentionDays: number;
	traceRetentionDays: number;
}

export interface LiveAcceptanceConfig {
	/** Worktree-local pre-check commands run by scripts/live-acceptance.ts before checks. */
	prepare: string[];
	/** Worktree-local acceptance checks run by scripts/live-acceptance.ts after task completion. */
	checks: string[];
	timeoutMs: number;
	pollMs: number;
}

export interface KanadeConfig {
	paths: KanadePaths;
	server: ServerConfig;
	isolation: IsolationConfig;
	merge: MergeConfig;
	tracing: TracingConfig;
	defaults: DefaultsConfig;
	models: ModelsConfig;
	network: NetworkConfig;
	debug: DebugConfig;
	cleanup: CleanupConfig;
	liveAcceptance: LiveAcceptanceConfig;
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
			// Preserve failed/aborted task worktrees by default so partial agent work can be inspected or recovered.
			// Explicit `kanade reject <task-id>` still removes the worktree and branch.
			autoCleanupOnReject: false,
			autoCleanupOnApprove: false,
			autoCleanupOnAbort: false,
			staleAfterDays: 7,
			maxConcurrent: 16,
			prepareCommands: [],
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
			authorModel: null,
			agentModel: null,
			roleModels: {},
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
		network: {
			httpProxy: null,
			httpsProxy: null,
			allProxy: null,
			noProxy: null,
			httpIdleTimeoutMs: 300_000,
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
		liveAcceptance: {
			prepare: [],
			checks: [],
			timeoutMs: 30 * 60 * 1000,
			pollMs: 10_000,
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

// ── Config validation + write (for PATCH/PUT /config API) ───────────────────

/** Top-level keys allowed in a config PATCH/PUT body. */
const EDITABLE_TOP_KEYS = new Set([
	"defaults",
	"isolation",
	"merge",
	"tracing",
	"models",
	"network",
	"debug",
	"cleanup",
	"liveAcceptance",
	"announcers",
]);

/** Nested field paths that must NOT be modified at runtime. */
const BLOCKED_PATHS = new Set([
	"paths",
	"server",
	"models.mode",
	"models.agentDir",
	"models.piAgentDir",
]);

export interface ConfigValidationResult {
	valid: boolean;
	errors: string[];
	sanitized: Partial<KanadeConfig>;
	requiresRestart: string[];
}

/**
 * Validate a partial config patch against allowed fields.
 * Returns errors for unknown/blocked fields and type mismatches.
 */
export function validateConfigPatch(patch: Record<string, unknown>): ConfigValidationResult {
	const errors: string[] = [];
	const requiresRestart: string[] = [];
	const sanitized: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(patch)) {
		if (!EDITABLE_TOP_KEYS.has(key)) {
			errors.push(`Unknown or read-only top-level key: "${key}"`);
			continue;
		}
		if (value === undefined) continue;
		if (value === null) {
			sanitized[key] = value;
			continue;
		}
		if (typeof value !== "object" || Array.isArray(value)) {
			// Top-level keys must be objects (except announcers which is an array)
			if (key === "announcers" && Array.isArray(value)) {
				sanitized[key] = value;
				continue;
			}
			errors.push(`"${key}" must be an object`);
			continue;
		}
		// Check nested blocked fields
		const nested = value as Record<string, unknown>;
		const cleanNested: Record<string, unknown> = {};
		for (const [nestedKey, nestedValue] of Object.entries(nested)) {
			const path = `${key}.${nestedKey}`;
			if (BLOCKED_PATHS.has(path)) {
				errors.push(`Blocked field: "${path}" (read-only)`);
				requiresRestart.push(path);
				continue;
			}
			cleanNested[nestedKey] = nestedValue;
		}
		sanitized[key] = cleanNested;
	}

	return { valid: errors.length === 0, errors, sanitized: sanitized as Partial<KanadeConfig>, requiresRestart };
}

/**
 * Mask sensitive fields in config before exposing via API.
 */
export function maskConfig(config: KanadeConfig): Record<string, unknown> {
	const masked = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
	const models = masked.models as Record<string, unknown> | undefined;
	if (models) {
		if (models.authPath) models.authPath = "<configured>";
		if (models.modelsPath) models.modelsPath = "<configured>";
	}
	// Remove internal paths from public view
	if (masked.paths) {
		const paths = masked.paths as Record<string, unknown>;
		// Keep root and configFile for debugging, mask internals
		masked.paths = {
			root: paths.root,
			configFile: paths.configFile,
		};
	}
	return masked;
}

/**
 * Write a partial config patch to config.yml (atomic replace).
 * Returns the new merged config after reload.
 */
export function writeConfigPatch(
	currentConfig: KanadeConfig,
	patch: Partial<KanadeConfig>,
): KanadeConfig {
	const configPath = currentConfig.paths.configFile;

	// Read existing YAML
	let existingYaml: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			existingYaml = YAML.parse(readFileSync(configPath, "utf8")) ?? {};
		} catch {
			existingYaml = {};
		}
	}

	// Deep merge patch into existing
	const merged = deepMerge(existingYaml, patch as Record<string, unknown>);

	// Atomic write: write to temp file, then rename
	const tmpPath = `${configPath}.tmp.${process.pid}`;
	const yaml = YAML.stringify(merged, { indent: 2 });
	writeFileSync(tmpPath, yaml, "utf8");

	// Rename is atomic on the same filesystem
	renameSync(tmpPath, configPath);

	// Reload and return
	return loadConfig();
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

	// Normalise backwards-compatible aliases.
	if (merged.models.mode === "pi") merged.models.mode = "inherit-pi";

	return merged;
}
