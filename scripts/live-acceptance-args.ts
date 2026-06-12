import { resolve } from "node:path";

export interface Args {
	baseUrl: string;
	prompt?: string;
	promptFile?: string;
	authorModel?: string;
	agentModel?: string;
	roleModels: Record<string, string>;
	cwd: string;
	timeoutMs: number;
	pollMs: number;
	checks: string[];
	prepare: string[];
	prepareCommands: string[];
	json: boolean;
	evidenceFile?: string;
}

export function parseArgs(
	argv: string[],
	defaults: Partial<Pick<Args, "baseUrl" | "cwd" | "timeoutMs" | "pollMs" | "authorModel" | "agentModel">> = {},
): Args {
	const args: Args = {
		baseUrl: defaults.baseUrl ?? process.env.KANADE_URL ?? "http://127.0.0.1:7777",
		cwd: defaults.cwd ?? process.cwd(),
		timeoutMs: defaults.timeoutMs ?? 30 * 60 * 1000,
		pollMs: defaults.pollMs ?? 10_000,
		...(defaults.authorModel ? { authorModel: defaults.authorModel } : {}),
		...(defaults.agentModel ? { agentModel: defaults.agentModel } : {}),
		checks: [],
		prepare: [],
		prepareCommands: [],
		roleModels: {},
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a value`);
			return value;
		};
		if (arg === "--base-url") args.baseUrl = next();
		else if (arg === "--prompt") args.prompt = next();
		else if (arg === "--prompt-file") args.promptFile = next();
		else if (arg === "--author-model") args.authorModel = next();
		else if (arg === "--agent-model") args.agentModel = next();
		else if (arg === "--role-model") {
			const value = next();
			const sep = value.indexOf("=");
			if (sep <= 0 || sep === value.length - 1) throw new Error("--role-model expects role=model");
			args.roleModels[value.slice(0, sep)] = value.slice(sep + 1);
		} else if (arg === "--cwd") args.cwd = resolve(next());
		else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
		else if (arg === "--poll-ms") args.pollMs = Number(next());
		else if (arg === "--prepare") args.prepare.push(next());
		else if (arg === "--prepare-command") args.prepareCommands.push(next());
		else if (arg === "--check") args.checks.push(next());
		else if (arg === "--json") args.json = true;
		else if (arg === "--evidence-file") args.evidenceFile = resolve(next());
		else if (arg === "--help" || arg === "-h") usageAndExit(0);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

export function usageAndExit(code: number): never {
	console.log(`Usage:
  npm run live:accept -- --prompt-file /tmp/task.txt
  npm run live:accept -- --prompt "..." --check "npm test"

Defaults are read from ~/.kanade/config.yml: defaults author/agent/role models, isolation.prepareCommands, and liveAcceptance prepare/checks/timeouts. CLI flags override config for one run.

Options:
  --prompt TEXT              Generated task prompt
  --prompt-file PATH         Read generated task prompt from file
  --author-model MODEL       Model used by the workflow author
  --agent-model MODEL        Default model used by workflow subagents
  --role-model R=M           Per-role subagent model override; repeatable
  --prepare-command COMMAND  Task-level prepare command, passed in task options.prepare_commands; repeatable
  --prepare COMMAND          Worktree-local pre-check command before checks, e.g. npm install; repeatable
  --cwd PATH                 Workspace cwd for the task and local checks (default: current cwd)
  --base-url URL             Kanade server URL (default: KANADE_URL or http://127.0.0.1:7777)
  --timeout-ms N             Poll timeout (default: 1800000)
  --poll-ms N                Poll interval (default: 10000)
  --check COMMAND            Local acceptance check to run after task completion; repeatable
  --json                     Print machine-readable JSON only
  --evidence-file PATH       Write machine-readable evidence JSON to PATH (default: task run dir)
`);
	process.exit(code);
}
