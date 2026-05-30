/**
 * OTel setup — initializes TracerProvider + LoggerProvider with configured exporters.
 *
 * Call once at server startup. Returns handles for use throughout the app.
 */

import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { Resource } from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { KanadeConfig } from "../config/index.ts";
import { FileLogExporter } from "./file-log-exporter.ts";
import { FileSpanExporter } from "./file-span-exporter.ts";
import { Logger, createLogger } from "./logger.ts";

export interface TracingHandle {
	tracer: ReturnType<typeof trace.getTracer>;
	logger: Logger;
	shutdown(): Promise<void>;
}

export function setupTracing(config: KanadeConfig): TracingHandle {
	if (!config.tracing.enabled) {
		return createNoopHandle();
	}

	const serviceName = config.tracing.serviceName;
	const exporters = resolveExporters(config);

	// ── Trace provider ────────────────────────────────────────────────────
	const resource = new Resource({ "service.name": serviceName });
	const tracerProvider = new BasicTracerProvider({ resource });

	const traceDir = exporters.find((e) => e.type === "file")?.dir ?? config.paths.tracesDir;
	tracerProvider.addSpanProcessor(
		new SimpleSpanProcessor(new FileSpanExporter({ dir: traceDir, serviceName, rotate: "daily" })),
	);

	trace.setGlobalTracerProvider(tracerProvider);

	// ── Log provider ──────────────────────────────────────────────────────
	const logDir = exporters.find((e) => e.type === "file")?.logDir ?? config.paths.logsDir;
	const logExporter = new FileLogExporter({ dir: logDir, serviceName, rotate: "daily" });

	// sdk-logs v0.x accepts `processors` in constructor
	const loggerProvider = new LoggerProvider({
		resource,
		processors: [new SimpleLogRecordProcessor(logExporter)],
	} as never);

	logs.setGlobalLoggerProvider(loggerProvider);

	const logger = createLogger(serviceName);

	return {
		tracer: trace.getTracer(serviceName),
		logger,
		async shutdown() {
			await tracerProvider.shutdown();
			await loggerProvider.shutdown();
		},
	};
}

function resolveExporters(config: KanadeConfig) {
	if (config.tracing.exporters && config.tracing.exporters.length > 0) {
		return config.tracing.exporters;
	}
	return [config.tracing.exporter];
}

function createNoopHandle(): TracingHandle {
	return {
		tracer: trace.getTracer("noop"),
		logger: new Logger(logs.getLogger("noop")),
		async shutdown() {},
	};
}
