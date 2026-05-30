import type { StateStore } from "../store/index.ts";
import type { HumanResponse } from "./types.ts";

export interface HumanGateOptions {
	pollIntervalMs?: number;
}

export class HumanGate {
	private readonly waiters = new Map<string, Set<(response: HumanResponse) => void>>();
	private readonly pollIntervalMs: number;

	constructor(
		private readonly store: StateStore,
		options: HumanGateOptions = {},
	) {
		this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
	}

	async wait(requestId: string, signal?: AbortSignal): Promise<HumanResponse> {
		const existing = this.getResolvedResponse(requestId);
		if (existing) return existing;
		if (signal?.aborted) throw new Error(`Human request aborted: ${requestId}`);

		return new Promise<HumanResponse>((resolve, reject) => {
			let settled = false;

			const interval = setInterval(() => {
				try {
					const response = this.getResolvedResponse(requestId);
					if (response) finish(response);
				} catch (error) {
					fail(error as Error);
				}
			}, this.pollIntervalMs);

			const cleanup = () => {
				if (settled) return;
				settled = true;
				clearInterval(interval);
				signal?.removeEventListener("abort", onAbort);
				const set = this.waiters.get(requestId);
				set?.delete(onWake);
				if (set?.size === 0) this.waiters.delete(requestId);
			};

			const finish = (response: HumanResponse) => {
				cleanup();
				resolve(response);
			};

			const fail = (error: Error) => {
				cleanup();
				reject(error);
			};

			const onWake = (response: HumanResponse) => finish(response);
			const onAbort = () => fail(new Error(`Human request aborted: ${requestId}`));

			let set = this.waiters.get(requestId);
			if (!set) {
				set = new Set();
				this.waiters.set(requestId, set);
			}
			set.add(onWake);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	resolve(requestId: string, response: HumanResponse): void {
		const row = this.store.getNeedsHuman(requestId);
		if (!row) throw new Error(`Human request not found: ${requestId}`);
		if (row.status !== "pending") throw new Error(`Human request is not pending: ${requestId}`);

		this.store.updateNeedsHuman(requestId, {
			status: "resolved",
			resolved_at: Date.now(),
			response: JSON.stringify(response),
		});

		const waiters = this.waiters.get(requestId);
		if (!waiters) return;
		for (const wake of waiters) wake(response);
	}

	private getResolvedResponse(requestId: string): HumanResponse | null {
		const row = this.store.getNeedsHuman(requestId);
		if (!row || row.status !== "resolved" || !row.response) return null;
		return JSON.parse(row.response) as HumanResponse;
	}
}
