import { serve } from "@hono/node-server";
import type { KanadeConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { type TracingHandle, setupTracing } from "../tracing/index.ts";
import { createApp } from "./app.ts";
import { EventBus } from "./event-bus.ts";
import { TaskManager } from "./task-manager.ts";

export { createApp } from "./app.ts";
export type { AppContext } from "./app.ts";
export { AppError } from "./errors.ts";
export { EventBus } from "./event-bus.ts";
export type { ServerEvent } from "./event-bus.ts";
export { TaskManager } from "./task-manager.ts";
export type { CreateTaskInput, CreateTaskResult, TaskOptions } from "./task-manager.ts";
export { WorkflowStore } from "./workflow-store.ts";
export type { WorkflowInfo } from "./workflow-store.ts";
export { LlmWorkflowAuthor, StubWorkflowAuthor } from "./workflow-author.ts";
export type { WorkflowAuthor } from "./workflow-author.ts";

export interface ServerHandle {
	url: string;
	tracing: TracingHandle;
	close(): void;
}

export function startServer(config: KanadeConfig): ServerHandle {
	const tracing = setupTracing(config);
	const logger = tracing.logger.forComponent("server");

	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store);
	const taskManager = new TaskManager(config, store, events, humanGate, undefined, tracing);

	// Recover pending human requests from previous run
	const recovered = humanGate.recover();
	if (recovered > 0) logger.info("recovered pending human requests", { count: String(recovered) });

	const app = createApp({ taskManager, events });

	const server = serve({ fetch: app.fetch, hostname: config.server.bind, port: config.server.port });
	logger.info("server started", {
		bind: config.server.bind,
		port: String(config.server.port),
		dir: config.paths.root,
	});

	return {
		url: `http://${config.server.bind}:${config.server.port}`,
		tracing,
		async close() {
			logger.info("server shutting down");
			server.close();
			await tracing.shutdown();
			store.close();
		},
	};
}
