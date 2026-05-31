/**
 * Announcer framework — dispatches task lifecycle events to external notification systems.
 *
 * Config-driven announcer registry with fallback chains.
 * Each announcer type (http_post, macos_notification, tts_local) is a pluggable handler.
 */

import { execSync } from "node:child_process";
import type { AnnouncerConfig } from "../config/config.ts";
import type { ServerEvent } from "./event-bus.ts";

export interface AnnounceContext {
	config: AnnouncerConfig;
	event: ServerEvent;
	renderedTitle: string;
	renderedBody: string;
}

export type AnnounceHandler = (ctx: AnnounceContext) => Promise<boolean>;
export type ProbeHandler = (config: AnnouncerConfig) => Promise<boolean>;

/** Generate a human-readable summary from event data */
function eventSummary(event: ServerEvent): string {
	const data = event.data as Record<string, unknown> | undefined;
	if (!data) return event.type;
	if (data.result !== undefined) return "finished with result";
	if (data.error) return `failed: ${String(data.error).slice(0, 100)}`;
	if (data.request) return "needs human input";
	return event.type;
}

/** Simple template rendering: {{task.id}}, {{event.type}}, {{event.summary}} */
export function renderTemplate(template: string, event: ServerEvent): string {
	const data = event.data as Record<string, unknown> | undefined;
	return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
		const k = key.trim();
		if (k === "task.id") return event.taskId ?? "";
		if (k === "event.type") return event.type;
		if (k === "event.summary") return eventSummary(event);
		if (k === "event.result") return data?.result ? JSON.stringify(data.result) : "";
		if (k === "event.error") return data?.error ? String(data.error) : "";
		return "";
	});
}

/** Built-in handlers for each announcer type */
const builtinHandlers: Record<string, AnnounceHandler> = {
	http_post: async (ctx) => {
		if (!ctx.config.url) return false;
		const res = await fetch(ctx.config.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: ctx.renderedTitle,
				message: ctx.renderedBody,
				event: ctx.event.type,
				taskId: ctx.event.taskId,
			}),
			signal: AbortSignal.timeout(ctx.config.timeout_ms ?? 5000),
		});
		return res.ok;
	},

	macos_notification: async (ctx) => {
		try {
			const title = ctx.renderedTitle.replace(/'/g, "\\'").replace(/"/g, '\\"');
			const body = ctx.renderedBody.replace(/'/g, "\\'").replace(/"/g, '\\"');
			execSync(`osascript -e 'display notification "${body}" with title "${title}"'`, {
				timeout: 5000,
				stdio: "ignore",
			});
			return true;
		} catch {
			return false;
		}
	},

	tts_local: async (ctx) => {
		try {
			const text = ctx.renderedBody.replace(/'/g, "\\'").replace(/"/g, '\\"');
			execSync(`say "${text}"`, { timeout: 10_000, stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	},
};

/** Built-in probe for http_post health check */
const builtinProbe: ProbeHandler = async (config) => {
	if (!config.url) return false;
	try {
		const res = await fetch(config.url, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
};

export interface DispatchResult {
	dispatched: boolean;
	announcer?: string;
}

export interface AnnouncerLogger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export class AnnouncerRegistry {
	private readonly announcers: Map<string, AnnouncerConfig> = new Map();
	private handlers: Record<string, AnnounceHandler> = { ...builtinHandlers };
	private probeHandler: ProbeHandler = builtinProbe;
	private disabledNames = new Set<string>();
	private readonly logger: AnnouncerLogger;

	constructor(configs: AnnouncerConfig[], logger?: AnnouncerLogger) {
		for (const config of configs) {
			this.announcers.set(config.name, config);
		}
		this.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {} };
	}

	/** Register a custom handler for an announcer type (for testing) */
	registerHandler(type: string, handler: AnnounceHandler): void {
		this.handlers[type] = handler;
	}

	/** Register a custom probe handler (for testing) */
	registerProbe(handler: ProbeHandler): void {
		this.probeHandler = handler;
	}

	/** Probe auto-enabled http_post announcers. Call once on startup. */
	async probe(): Promise<void> {
		for (const [name, config] of this.announcers) {
			if (config.enabled !== "auto" || config.type !== "http_post") continue;
			try {
				const ok = await this.probeHandler(config);
				if (!ok) {
					this.logger.warn(`announcer probe failed: ${name} (${config.url})`);
					this.disabledNames.add(name);
				}
			} catch {
				this.logger.warn(`announcer probe error: ${name} (${config.url})`);
				this.disabledNames.add(name);
			}
		}
	}

	/** Dispatch an event to matching announcers with fallback chain. */
	async dispatch(event: ServerEvent): Promise<DispatchResult> {
		let current = this.findMatching(event);
		while (current) {
			const name = current.name;
			const fallbackName = current.fallback;
			try {
				const ctx = this.buildContext(current, event);
				const handler = this.handlers[current.type];
				if (!handler) {
					this.logger.warn(`announcer handler not found: ${current.type} (${name})`);
					current = fallbackName ? this.announcers.get(fallbackName) : undefined;
					continue;
				}
				const ok = await handler(ctx);
				if (ok) {
					this.logger.info(`announcer dispatched: ${name} ← ${event.type}`);
					return { dispatched: true, announcer: current.name };
				}
				this.logger.warn(`announcer returned false: ${name} ← ${event.type}`);
			} catch (err) {
				this.logger.error(`announcer handler error: ${name} ← ${event.type}: ${err}`);
			}
			current = fallbackName ? this.announcers.get(fallbackName) : undefined;
		}
		return { dispatched: false };
	}

	private findMatching(event: ServerEvent): AnnouncerConfig | undefined {
		for (const [, config] of this.announcers) {
			if (!this.isEnabled(config)) continue;
			if (!config.events.includes(event.type)) continue;
			return config;
		}
		return undefined;
	}

	private isEnabled(config: AnnouncerConfig): boolean {
		if (this.disabledNames.has(config.name)) return false;
		if (config.enabled === true) return true;
		if (config.enabled === "auto") return true;
		return false;
	}

	private buildContext(config: AnnouncerConfig, event: ServerEvent): AnnounceContext {
		return {
			config,
			event,
			renderedTitle: renderTemplate(config.title_template ?? config.name, event),
			renderedBody: renderTemplate(config.body_template ?? eventSummary(event), event),
		};
	}
}
