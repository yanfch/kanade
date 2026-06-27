/**
 * FileSpanExporter — writes spans as OTLP-JSON lines to local files.
 *
 * One JSON object per line, daily rotation, symlink `current/` → today.
 * Fail-soft: disk errors are logged to stderr and the span is dropped.
 */

import { appendFileSync, existsSync, mkdirSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

export interface FileSpanExporterOptions {
	/** Directory to write span files into (e.g. ~/.kanade/traces) */
	dir: string;
	/** Service name used in the filename */
	serviceName: string;
	/** Rotation interval. Default: daily */
	rotate?: "daily" | "hourly" | "none";
}

export class FileSpanExporter implements SpanExporter {
	private readonly dir: string;
	private readonly serviceName: string;
	private readonly rotate: "daily" | "hourly" | "none";
	private currentSlot: string | null = null;

	constructor(options: FileSpanExporterOptions) {
		this.dir = options.dir;
		this.serviceName = options.serviceName;
		this.rotate = options.rotate ?? "daily";
	}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		try {
			for (const span of spans) {
				const line = this.serialize(span);
				this.appendLine(line);
			}
			resultCallback({ code: ExportResultCode.SUCCESS });
		} catch (err) {
			console.error("[FileSpanExporter] write error:", err);
			resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
		}
	}

	async shutdown(): Promise<void> {
		// nothing to flush
	}

	private serialize(span: ReadableSpan): string {
		const record: Record<string, unknown> = {
			traceId: span.spanContext().traceId,
			spanId: span.spanContext().spanId,
			parentSpanId: span.parentSpanContext?.spanId,
			name: span.name,
			kind: span.kind,
			startTime: span.startTime,
			endTime: span.endTime,
			status: span.status,
			attributes: span.attributes,
			events: span.events.map((e) => ({
				name: e.name,
				time: e.time,
				attributes: e.attributes,
			})),
			resource: span.resource.attributes,
		};
		return JSON.stringify(record);
	}

	private appendLine(line: string): void {
		const slot = this.currentSlotName();
		if (slot !== this.currentSlot) {
			this.rotateTo(slot);
			this.currentSlot = slot;
		}

		const filePath = this.currentFilePath();
		appendFileSync(filePath, `${line}\n`, "utf8");
	}

	private currentSlotName(): string {
		const now = new Date();
		if (this.rotate === "hourly") {
			return `${this.datePart(now)}-${String(now.getHours()).padStart(2, "0")}`;
		}
		if (this.rotate === "none") {
			return "current";
		}
		return this.datePart(now);
	}

	private datePart(d: Date): string {
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	}

	private currentFilePath(): string {
		const dayDir = join(this.dir, this.currentSlot!);
		if (!existsSync(dayDir)) mkdirSync(dayDir, { recursive: true });
		return join(dayDir, `${this.serviceName}.jsonl`);
	}

	private rotateTo(slot: string): void {
		const dayDir = join(this.dir, slot);
		if (!existsSync(dayDir)) mkdirSync(dayDir, { recursive: true });

		// update current/ symlink
		const symlinkPath = join(this.dir, "current");
		try {
			if (existsSync(symlinkPath)) {
				const target = readlinkSync(symlinkPath);
				if (target !== slot) {
					unlinkSync(symlinkPath);
					writeFileSync(symlinkPath, slot, "utf8");
				}
			} else {
				writeFileSync(symlinkPath, slot, "utf8");
			}
		} catch {
			// symlink update is best-effort
		}
	}
}
