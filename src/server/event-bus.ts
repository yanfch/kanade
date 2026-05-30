import { EventEmitter } from "node:events";

export interface ServerEvent<T = unknown> {
	type: string;
	taskId?: string;
	data: T;
	ts: number;
}

export class EventBus {
	private readonly emitter = new EventEmitter();

	emit<T>(type: string, data: T, taskId?: string): ServerEvent<T> {
		const event: ServerEvent<T> = { type, data, taskId, ts: Date.now() };
		this.emitter.emit("event", event);
		if (taskId) this.emitter.emit(`task:${taskId}`, event);
		return event;
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
