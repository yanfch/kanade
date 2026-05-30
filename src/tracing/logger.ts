/**
 * Structured logger wrapping OTel Logs API.
 *
 * Every log record automatically carries traceId/spanId from the active context,
 * making it possible to correlate logs with traces via a single traceId grep.
 *
 * Usage:
 *   const logger = createLogger('kanade');
 *   const taskLog = logger.forTask('T-2042');
 *   taskLog.info('task started', { source: 'saved' });
 *   taskLog.error('agent failed', error, { label: 'dev' });
 */

import { SeverityNumber, logs } from "@opentelemetry/api-logs";

export interface LogFields {
	[key: string]: string | number | boolean | undefined;
}

export class Logger {
	constructor(
		private readonly otelLogger: ReturnType<typeof logs.getLogger>,
		private readonly defaultAttrs: Record<string, string> = {},
	) {}

	info(message: string, fields?: LogFields): void {
		this.emit(SeverityNumber.INFO, "INFO", message, fields);
	}

	warn(message: string, fields?: LogFields): void {
		this.emit(SeverityNumber.WARN, "WARN", message, fields);
	}

	error(message: string, error?: Error, fields?: LogFields): void {
		const merged: LogFields = { ...fields };
		if (error) {
			merged["error.type"] = error.name;
			merged["error.message"] = error.message;
			if (error.stack) merged["error.stack"] = error.stack;
		}
		this.emit(SeverityNumber.ERROR, "ERROR", message, merged);
	}

	debug(message: string, fields?: LogFields): void {
		this.emit(SeverityNumber.DEBUG, "DEBUG", message, fields);
	}

	/** Return a child logger with task context pre-filled. */
	forTask(taskId: string): Logger {
		return new Logger(this.otelLogger, { ...this.defaultAttrs, "kanade.task.id": taskId });
	}

	/** Return a child logger with component context pre-filled. */
	forComponent(component: string): Logger {
		return new Logger(this.otelLogger, { ...this.defaultAttrs, "kanade.component": component });
	}

	private emit(severityNumber: number, severityText: string, message: string, fields?: LogFields): void {
		const attributes: Record<string, string | number | boolean> = { ...this.defaultAttrs };
		if (fields) {
			for (const [key, value] of Object.entries(fields)) {
				if (value !== undefined) attributes[key] = value;
			}
		}

		this.otelLogger.emit({
			severityNumber,
			severityText,
			body: message,
			attributes,
			// traceId/spanId are injected automatically by OTel from the active context
		});
	}
}

/**
 * Create a Logger instance using the global OTel logger provider.
 */
export function createLogger(name: string, version?: string): Logger {
	const otelLogger = logs.getLogger(name, version);
	return new Logger(otelLogger);
}
