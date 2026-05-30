import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/index.ts";
import { Logger } from "./logger.ts";
import { FileSpanExporter } from "./file-span-exporter.ts";
import { FileLogExporter } from "./file-log-exporter.ts";
import { setupTracing } from "./setup.ts";

function makeConfig(overrides?: { tracesDir?: string; logsDir?: string }) {
	const root = mkdtempSync(join(tmpdir(), "kanade-trace-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	// Override dirs via mutation (readonly in type but mutable at runtime)
	if (overrides?.tracesDir) (config.paths as unknown as Record<string, string>).tracesDir = overrides.tracesDir;
	if (overrides?.logsDir) (config.paths as unknown as Record<string, string>).logsDir = overrides.logsDir;
	return { config, root };
}

describe("FileSpanExporter", () => {
	it("writes spans as JSONL files with daily rotation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-spans-"));
		const exporter = new FileSpanExporter({ dir, serviceName: "test", rotate: "daily" });

		// Create a minimal mock span
		const span = {
			spanContext: () => ({ traceId: "abc123def456abc123def456", spanId: "1234567890abcdef", traceFlags: 1 }),
			parentSpanId: undefined,
			name: "test.span",
			kind: 0,
			startTime: [1000, 0],
			endTime: [1001, 0],
			status: { code: 0 },
			attributes: { "test.key": "value" },
			events: [],
			resource: { attributes: { "service.name": "test" } },
		};

		await new Promise<void>((resolve, reject) => {
			exporter.export([span as never], (result) => {
				if (result.code === 0) resolve();
				else reject(result.error);
			});
		});

		// Find the output file
		const today = new Date();
		const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		const filePath = join(dir, dateStr, "test.jsonl");
		expect(existsSync(filePath)).toBe(true);

		const content = readFileSync(filePath, "utf8").trim();
		const parsed = JSON.parse(content);
		expect(parsed.traceId).toBe("abc123def456abc123def456");
		expect(parsed.spanId).toBe("1234567890abcdef");
		expect(parsed.name).toBe("test.span");
		expect(parsed.attributes["test.key"]).toBe("value");
	});

	it("creates directory structure on first write", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-spans2-"));
		const exporter = new FileSpanExporter({ dir, serviceName: "svc" });

		const span = {
			spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
			name: "x",
			kind: 0,
			startTime: [0, 0],
			endTime: [0, 0],
			status: { code: 0 },
			attributes: {},
			events: [],
			resource: { attributes: {} },
		};

		await new Promise<void>((resolve) => {
			exporter.export([span as never], () => resolve());
		});

		const entries = readdirSync(dir);
		expect(entries.length).toBeGreaterThanOrEqual(1);
		expect(entries).toContain("current");
	});
});

describe("FileLogExporter", () => {
	it("writes log records as JSONL with traceId/spanId", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-logs-"));
		const exporter = new FileLogExporter({ dir, serviceName: "test", rotate: "daily" });

		const logRecord = {
			hrTime: [1000, 0],
			severityNumber: 9,
			severityText: "INFO",
			body: "task finished",
			attributes: { "kanade.task.id": "T-2042" },
			spanContext: { traceId: "abc123def456abc123def456", spanId: "1234567890abcdef", traceFlags: 1 },
			resource: { attributes: { "service.name": "test" } },
		};

		await new Promise<void>((resolve, reject) => {
			exporter.export([logRecord as never], (result) => {
				if (result.code === 0) resolve();
				else reject(result.error);
			});
		});

		const today = new Date();
		const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		const filePath = join(dir, dateStr, "test.jsonl");
		expect(existsSync(filePath)).toBe(true);

		const content = readFileSync(filePath, "utf8").trim();
		const parsed = JSON.parse(content);
		expect(parsed.body).toBe("task finished");
		expect(parsed.traceId).toBe("abc123def456abc123def456");
		expect(parsed.spanId).toBe("1234567890abcdef");
		expect(parsed.severityText).toBe("INFO");
		expect(parsed.attributes["kanade.task.id"]).toBe("T-2042");
	});
});

describe("setupTracing", () => {
	it("returns noop handle when tracing is disabled", () => {
		const { config } = makeConfig();
		config.tracing.enabled = false;

		const handle = setupTracing(config);

		expect(handle.tracer).toBeDefined();
		expect(handle.logger).toBeDefined();
		// Should not throw
		handle.logger.info("test");
	});

	it("returns working handle when tracing is enabled", () => {
		const tracesDir = mkdtempSync(join(tmpdir(), "kanade-traces-"));
		const logsDir = mkdtempSync(join(tmpdir(), "kanade-logs-"));
		const { config } = makeConfig({ tracesDir, logsDir });

		const handle = setupTracing(config);

		expect(handle.tracer).toBeDefined();
		expect(handle.logger).toBeDefined();

		// Create a span to verify the pipeline works
		const span = handle.tracer.startSpan("test.span");
		span.setAttribute("test.key", "value");
		span.end();

		// Log something
		handle.logger.info("test log message");

		// File outputs are async (SimpleSpanProcessor/LogRecordProcessor are sync in our impl)
		// so data should be written already
	});

	it("logger.forTask() sets task context", () => {
		const tracesDir = mkdtempSync(join(tmpdir(), "kanade-traces-"));
		const logsDir = mkdtempSync(join(tmpdir(), "kanade-logs-"));
		const { config } = makeConfig({ tracesDir, logsDir });

		const handle = setupTracing(config);
		const taskLogger = handle.logger.forTask("T-2042");
		expect(taskLogger).toBeInstanceOf(Logger);

		// Should not throw
		const taskLog2 = handle.logger.forTask("T-2042");
		taskLog2.info("task specific log");
	});
});

describe("Logger", () => {
	it("creates child loggers with forTask and forComponent", () => {
		const tracesDir = mkdtempSync(join(tmpdir(), "kanade-traces-"));
		const logsDir = mkdtempSync(join(tmpdir(), "kanade-logs-"));
		const { config } = makeConfig({ tracesDir, logsDir });
		const handle = setupTracing(config);

		const taskLog = handle.logger.forTask("T-0001");
		const componentLog = handle.logger.forComponent("agent");

		// Both should be Logger instances
		expect(taskLog).toBeInstanceOf(Logger);
		expect(componentLog).toBeInstanceOf(Logger);

		// Should not throw
		taskLog.info("task log");
		componentLog.warn("component warning");
		componentLog.error("component error", new Error("test"));
		componentLog.debug("component debug");
	});
});
