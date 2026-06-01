import { EventEmitter } from "node:events";

export interface ServerEvent<T = unknown> {
	id: number;
	type: string;
	taskId?: string;
	data: T;
	ts: number;
}

export class EventBus {
	private readonly emitter = new EventEmitter();
	private nextId = 1;
	private readonly taskEvents = new Map<string, ServerEvent[]>();

	constructor(private readonly maxEventsPerTask = 200) {}

	emit<T>(type: string, data: T, taskId?: string): ServerEvent<T> {
		const event: ServerEvent<T> = { id: this.nextId++, type, data, taskId, ts: Date.now() };
		if (taskId) this.storeTaskEvent(taskId, event);
		this.emitter.emit("event", event);
		if (taskId) this.emitter.emit(`task:${taskId}`, event);
		return event;
	}

	getTaskEvents(taskId: string): ServerEvent[] {
		return [...(this.taskEvents.get(taskId) ?? [])];
	}

	private storeTaskEvent(taskId: string, event: ServerEvent): void {
		const list = this.taskEvents.get(taskId) ?? [];
		list.push(event);
		if (list.length > this.maxEventsPerTask) list.splice(0, list.length - this.maxEventsPerTask);
		this.taskEvents.set(taskId, list);
	}

	replayAndSubscribe(
		taskId: string,
		listener: (event: ServerEvent) => void,
	): { past: ServerEvent[]; unsubscribe: () => void } {
		const past = this.getTaskEvents(taskId);
		const off = this.onTask(taskId, listener);
		return { past, unsubscribe: off };
	}

	onAny(listener: (event: ServerEvent) => void): () => void {
		this.emitter.on("event", listener);
		return () => this.emitter.off("event", listener);
	}

	onTask(taskId: string, listener: (event: ServerEvent) => void): () => void {
		const key = `task:${taskId}`;
		this.emitter.on(key, listener);
		return () => this.emitter.off(key, listener);
	}
}
