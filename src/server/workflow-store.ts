import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type WorkflowMeta, parseWorkflowScript } from "../workflow-engine/index.ts";

export interface WorkflowInfo {
	name: string;
	meta: WorkflowMeta;
	script: string;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class WorkflowStore {
	constructor(private readonly dir: string) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}

	list(): WorkflowInfo[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((f) => f.endsWith(".js"))
			.sort()
			.flatMap((f) => {
				const info = this.get(f.slice(0, -3));
				return info ? [info] : [];
			});
	}

	get(name: string): WorkflowInfo | null {
		if (!NAME_RE.test(name)) return null;
		const filePath = join(this.dir, `${name}.js`);
		if (!existsSync(filePath)) return null;
		const script = readFileSync(filePath, "utf8");
		try {
			const { meta } = parseWorkflowScript(script);
			return { name, meta, script };
		} catch {
			return null;
		}
	}

	put(name: string, script: string): void {
		if (!name?.trim() || !NAME_RE.test(name)) {
			throw new Error("workflow name must contain only alphanumeric characters, hyphens, and underscores");
		}
		parseWorkflowScript(script); // validates meta; throws on invalid
		writeFileSync(join(this.dir, `${name}.js`), script, "utf8");
	}

	delete(name: string): boolean {
		if (!NAME_RE.test(name)) return false;
		const filePath = join(this.dir, `${name}.js`);
		if (!existsSync(filePath)) return false;
		rmSync(filePath);
		return true;
	}

	/** Check whether a saved workflow with the given name already exists. */
	exists(name: string): boolean {
		if (!NAME_RE.test(name)) return false;
		return existsSync(join(this.dir, `${name}.js`));
	}
}
