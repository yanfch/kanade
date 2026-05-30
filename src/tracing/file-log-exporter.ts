/**
 * FileLogExporter — writes OTel LogRecords as JSON lines to local files.
 *
 * Same rotation strategy as FileSpanExporter: daily directory + current/ symlink.
 * Each log record automatically carries traceId/spanId from the OTel context.
 */

import { appendFileSync, existsSync, mkdirSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableLogRecord, LogRecordExporter } from "@opentelemetry/sdk-logs";

export interface FileLogExporterOptions {
	/** Directory to write log files into (e.g. ~/.kanade/logs) */
	dir: string;
	/** Service name used in the filename */
	serviceName: string;
	/** Rotation interval. Default: daily */
	rotate?: "daily" | "hourly" | "none";
}

export class FileLogExporter implements LogRecordExporter {
	private readonly dir: string;
	private readonly serviceName: string;
	private readonly rotate: "daily" | "hourly" | "none";
	private currentSlot: string | null = null;

	constructor(options: FileLogExporterOptions) {
		this.dir = options.dir;
		this.serviceName = options.serviceName;
		this.rotate = options.rotate ?? "daily";
	}

	export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
		try {
			for (const log of logs) {
				const line = this.serialize(log);
				this.appendLine(line);
			}
			resultCallback({ code: ExportResultCode.SUCCESS });
		} catch (err) {
			console.error("[FileLogExporter] write error:", err);
			resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
		}
	}

	async forceFlush(): Promise<void> {}

	async shutdown(): Promise<void> {}

	private serialize(log: ReadableLogRecord): string {
		const record: Record<string, unknown> = {
			timestamp: log.hrTime ? log.hrTime[0] * 1e9 + log.hrTime[1] : undefined,
			severityNumber: log.severityNumber,
			severityText: log.severityText,
			body: log.body,
			attributes: log.attributes,
		};

		// Add trace context if present
		const ctx = log.spanContext;
		if (ctx) {
			record.traceId = ctx.traceId;
			record.spanId = ctx.spanId;
			if (ctx.traceFlags) record.traceFlags = ctx.traceFlags;
		}

		// Add resource info
		if (log.resource?.attributes) {
			record.resource = log.resource.attributes;
		}

		return JSON.stringify(record);
	}

	private appendLine(line: string): void {
		const slot = this.currentSlotName();
		if (slot !== this.currentSlot) {
			this.rotateTo(slot);
			this.currentSlot = slot;
		}

		const filePath = this.currentFilePath();
		appendFileSync(filePath, line + "\n", "utf8");
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
			// best-effort
		}
	}
}
