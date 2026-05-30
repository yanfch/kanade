import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { KanadePaths } from "../config/index.ts";

export interface RoleToolsConfig {
	allow: string[];
	extensions: string[];
}

export interface RoleConfig {
	name: string;
	dir: string;
	systemPrompt: string;
	tools: RoleToolsConfig;
	defaultSchema?: unknown;
	defaultModel?: string;
	extensionPaths: string[];
}

export interface LoadRoleOptions {
	rolesDir: KanadePaths["rolesDir"];
}

export function loadRole(name: string, options: LoadRoleOptions): RoleConfig {
	validateRoleName(name);

	const dir = join(options.rolesDir, name);
	if (!existsSync(dir)) throw new Error(`Role not found: ${name}`);

	const systemPrompt = readRequiredText(join(dir, "role.md"), `role ${name} is missing role.md`).trim();
	if (!systemPrompt) throw new Error(`role ${name} has empty role.md`);

	const tools = readToolsConfig(join(dir, "tools.json"));
	const defaultSchema = readOptionalJson(join(dir, "default-schema.json"));
	const defaultModel = readOptionalText(join(dir, "default-model.txt"))?.trim() || undefined;
	const extensionPaths = resolveExtensionPaths(dir, tools.extensions);

	return {
		name,
		dir,
		systemPrompt,
		tools,
		defaultSchema,
		defaultModel,
		extensionPaths,
	};
}

export function validateRoleName(name: string): void {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		throw new Error(`Invalid role name: ${name}. Role names must be kebab-case directory names.`);
	}
}

export function filterToolsByWhitelist<TTool extends { name: string }>(tools: TTool[], allow: string[]): TTool[] {
	const allowed = new Set(allow);
	return tools.filter((tool) => allowed.has(tool.name));
}

function readToolsConfig(path: string): RoleToolsConfig {
	if (!existsSync(path)) return { allow: [], extensions: [] };
	const raw = readRequiredText(path, `Failed to read ${path}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${(error as Error).message}`);
	}

	if (!parsed || typeof parsed !== "object") throw new Error(`${path} must be a JSON object`);
	const value = parsed as { allow?: unknown; extensions?: unknown };
	if (!Array.isArray(value.allow) || !value.allow.every((item) => typeof item === "string")) {
		throw new Error(`${path} must contain { "allow": string[] }`);
	}
	if (value.extensions !== undefined) {
		if (!Array.isArray(value.extensions) || !value.extensions.every((item) => typeof item === "string")) {
			throw new Error(`${path} extensions must be string[]`);
		}
	}

	return { allow: value.allow, extensions: value.extensions ?? [] };
}

function resolveExtensionPaths(roleDir: string, configured: string[]): string[] {
	const extensionDir = join(roleDir, "extensions");
	const fromDir = existsSync(extensionDir)
		? readdirSync(extensionDir)
				.filter((entry) => entry.endsWith(".ts"))
				.sort()
				.map((entry) => join(extensionDir, entry))
		: [];
	const fromConfig = configured.map((entry) => join(roleDir, entry));
	return [...new Set([...fromConfig, ...fromDir])];
}

function readRequiredText(path: string, message: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`${message}: ${(error as Error).message}`);
	}
}

function readOptionalText(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readRequiredText(path, `Failed to read ${path}`);
}

function readOptionalJson(path: string): unknown {
	const raw = readOptionalText(path);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${(error as Error).message}`);
	}
}
