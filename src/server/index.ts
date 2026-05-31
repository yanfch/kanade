import { serve } from "@hono/node-server";
import type { KanadeConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { type TracingHandle, setupTracing } from "../tracing/index.ts";
import { AnnouncerRegistry } from "./announcer.ts";
import { createApp } from "./app.ts";
import { CleanupScheduler } from "./cleanup-scheduler.ts";
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

	// Start announcer registry
	const announcerRegistry = new AnnouncerRegistry(config.announcers, tracing.logger.forComponent("announcer"));
	announcerRegistry.probe().catch(() => {});
	events.onAny((event) => {
		announcerRegistry.dispatch(event).catch(() => {});
	});

	// Start cleanup scheduler
	const cleanupScheduler = new CleanupScheduler({
		config: config.cleanup,
		paths: config.paths,
		isolation: taskManager.isolationManager,
		staleAfterDays: config.isolation.staleAfterDays,
		logger: tracing.logger.forComponent("cleanup"),
	});
	cleanupScheduler.start();

	const app = createApp({ taskManager, events, config });

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
			cleanupScheduler.stop();
			server.close();
			await tracing.shutdown();
			store.close();
		},
	};
}
