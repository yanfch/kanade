import type { SettingsGroup, Tab } from "./types.ts";

export const TASK_EVENT_TYPES = [
	"task.created",
	"task.running",
	"task.finished",
	"task.failed",
	"task.aborted",
	"task.needs_human",
	"task.human_resolved",
	"task.merged",
	"task.rejected",
	"task.script_generated",
	"workflow.phase",
	"workflow.agent_started",
	"workflow.agent_completed",
	"workflow.log",
];

export const DEFAULT_BASE_URL = "http://127.0.0.1:7777";
export const TABS: readonly Tab[] = ["Map", "Agent", "Events", "Worktree", "Usage", "Result", "Review"];
export const PANEL_BODY_ROWS = 32;
export const MAX_VISIBLE_TASKS = 10;
export const MAX_VISIBLE_NARROW_TASKS = 5;
export const MAX_VISIBLE_AGENT_EVENTS = 3;
export const ESC = String.fromCharCode(27);
export const CLEAR_CELL = "\u00A0";
export const ANSI_SGR_PREFIX = new RegExp(`^${ESC}\\[[0-9;]*m`);
export const ANSI_SGR_GLOBAL = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
	{
		section: "models",
		label: "Models",
		fields: [
			{ key: "models.modelsPath", section: "models", label: "Models Path", type: "string" },
			{ key: "models.inheritPiSettings", section: "models", label: "Inherit Pi Settings", type: "boolean" },
			{
				key: "models.disableSubagentCompaction",
				section: "models",
				label: "Disable Subagent Compaction",
				type: "boolean",
			},
		],
	},
	{
		section: "defaults",
		label: "Defaults",
		fields: [
			{ key: "defaults.maxConcurrentTasks", section: "defaults", label: "Max Concurrent Tasks", type: "number" },
			{ key: "defaults.concurrency", section: "defaults", label: "Concurrency", type: "number" },
			{ key: "defaults.agentTimeoutMs", section: "defaults", label: "Agent Timeout Ms", type: "number" },
			{ key: "defaults.authorModel", section: "defaults", label: "Author Model", type: "string" },
			{ key: "defaults.agentModel", section: "defaults", label: "Agent Model", type: "string" },
			{ key: "defaults.roleModels", section: "defaults", label: "Role Models", type: "record" },
		],
	},
	{
		section: "isolation",
		label: "Isolation",
		fields: [{ key: "isolation.defaultMode", section: "isolation", label: "Isolation Mode", type: "string" }],
	},
	{
		section: "merge",
		label: "Merge",
		fields: [{ key: "merge.targetBranch", section: "merge", label: "Target Branch", type: "string" }],
	},
	{
		section: "debug",
		label: "Debug",
		fields: [
			{ key: "debug.persistSubagents", section: "debug", label: "Persist Subagents", type: "boolean" },
			{ key: "debug.dumpArtifacts", section: "debug", label: "Dump Artifacts", type: "boolean" },
		],
	},
	{
		section: "cleanup",
		label: "Cleanup",
		fields: [
			{ key: "cleanup.enabled", section: "cleanup", label: "Cleanup Enabled", type: "boolean", dangerous: true },
			{ key: "cleanup.schedule", section: "cleanup", label: "Cleanup Schedule", type: "string", dangerous: true },
		],
	},
	{
		section: "network",
		label: "Network",
		fields: [
			{ key: "network.httpProxy", section: "network", label: "HTTP Proxy", type: "string" },
			{ key: "network.httpsProxy", section: "network", label: "HTTPS Proxy", type: "string" },
			{ key: "network.allProxy", section: "network", label: "All Proxy", type: "string" },
			{ key: "network.noProxy", section: "network", label: "No Proxy", type: "string" },
			{ key: "network.httpIdleTimeoutMs", section: "network", label: "HTTP Idle Timeout Ms", type: "number" },
		],
	},
	{
		section: "liveAcceptance",
		label: "Live Acceptance",
		fields: [
			{ key: "liveAcceptance.timeoutMs", section: "liveAcceptance", label: "Timeout Ms", type: "number" },
			{ key: "liveAcceptance.pollMs", section: "liveAcceptance", label: "Poll Ms", type: "number" },
		],
	},
	{
		section: "_readonly",
		label: "Read-only / Sensitive",
		fields: [
			{ key: "models.mode", section: "models", label: "Mode", type: "string", readOnly: true },
			{ key: "models.authPath", section: "models", label: "Auth Path", type: "string", readOnly: true },
			{ key: "models.agentDir", section: "models", label: "Agent Dir", type: "string", readOnly: true },
			{ key: "models.piAgentDir", section: "models", label: "Pi Agent Dir", type: "string", readOnly: true },
			{ key: "paths.root", section: "paths", label: "Root", type: "string", readOnly: true },
			{ key: "paths.configFile", section: "paths", label: "Config File", type: "string", readOnly: true },
			{ key: "paths.dbDir", section: "paths", label: "DB Dir", type: "string", readOnly: true },
			{ key: "paths.rolesDir", section: "paths", label: "Roles Dir", type: "string", readOnly: true },
			{ key: "paths.workflowsDir", section: "paths", label: "Workflows Dir", type: "string", readOnly: true },
			{ key: "paths.runsDir", section: "paths", label: "Runs Dir", type: "string", readOnly: true },
			{ key: "paths.worktreesDir", section: "paths", label: "Worktrees Dir", type: "string", readOnly: true },
			{ key: "paths.tracesDir", section: "paths", label: "Traces Dir", type: "string", readOnly: true },
			{ key: "paths.stateDb", section: "paths", label: "State DB", type: "string", readOnly: true },
			{ key: "paths.logsDir", section: "paths", label: "Logs Dir", type: "string", readOnly: true },
			{
				key: "paths.sharedExtensionsDir",
				section: "paths",
				label: "Shared Extensions Dir",
				type: "string",
				readOnly: true,
			},
			{ key: "server.port", section: "server", label: "Port", type: "number", readOnly: true },
			{ key: "server.bind", section: "server", label: "Bind", type: "string", readOnly: true },
		],
	},
];
