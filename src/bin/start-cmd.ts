/**
 * Start command's cmd resolution logic.
 *
 * Determines which command to use for starting the kanade server:
 * - If --cmd is specified, use that directly
 * - Otherwise, resolve from the kanade script path (process.argv[1])
 */

import { dirname, join } from "node:path";

export interface ResolveStartCmdOptions {
	/** Explicit command from --cmd option */
	cmd?: string;
	/** Path to the kanade script (defaults to process.argv[1]) */
	kanadeScriptPath?: string;
	/** Working directory */
	cwd?: string;
}

export interface ResolvedStartCmd {
	/** The command to execute */
	cmd: string;
	/** Source of the command: 'explicit' or 'kanade-path' */
	source: "explicit" | "kanade-path";
	/** Working directory for the server */
	cwd: string;
}

/**
 * Resolves the command to use for starting the kanade server.
 *
 * Priority:
 * 1. Explicit --cmd option
 * 2. Resolve from kanade script path (process.argv[1])
 */
export function resolveStartCmd(options: ResolveStartCmdOptions = {}): ResolvedStartCmd {
	const { cmd: explicitCmd, kanadeScriptPath, cwd } = options;

	// If explicit command is provided, use it
	if (explicitCmd?.trim()) {
		return {
			cmd: explicitCmd.trim(),
			source: "explicit",
			cwd: cwd ?? process.cwd(),
		};
	}

	// Otherwise, resolve from kanade script path
	const scriptPath = kanadeScriptPath ?? process.argv[1];
	const scriptDir = dirname(scriptPath);
	const serverPath = join(scriptDir, "server.ts");

	return {
		cmd: `npx tsx ${serverPath}`,
		source: "kanade-path",
		cwd: cwd ?? process.cwd(),
	};
}
