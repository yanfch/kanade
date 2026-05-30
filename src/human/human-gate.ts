import type { StateStore } from "../store/index.ts";
import type { HumanResponse } from "./types.ts";

export interface HumanGateOptions {
	/** Initial poll interval in ms. Default: 100 */
	initialPollMs?: number;
	/** Maximum poll interval in ms. Default: 30000 (30s) */
	maxPollMs?: number;
	/** Stop polling after this many ms. Default: 300000 (5min) */
	pollTimeoutMs?: number;
}

export class HumanGate {
	private readonly waiters = new Map<string, Set<(response: HumanResponse) => void>>();
	private readonly initialPollMs: number;
	private readonly maxPollMs: number;
	private readonly pollTimeoutMs: number;

	constructor(
		private readonly store: StateStore,
		options: HumanGateOptions = {},
	) {
		this.initialPollMs = options.initialPollMs ?? 100;
		this.maxPollMs = options.maxPollMs ?? 30_000;
		this.pollTimeoutMs = options.pollTimeoutMs ?? 300_000;
	}

	async wait(requestId: string, signal?: AbortSignal): Promise<HumanResponse> {
		const existing = this.getResolvedResponse(requestId);
		if (existing) return existing;
		if (signal?.aborted) throw new Error(`Human request aborted: ${requestId}`);

		return new Promise<HumanResponse>((resolve, reject) => {
			let settled = false;
			let pollMs = this.initialPollMs;
			let elapsed = 0;
			let timer: ReturnType<typeof setTimeout> | null = null;

			const poll = () => {
				if (settled) return;
				try {
					const response = this.getResolvedResponse(requestId);
					if (response) {
						finish(response);
						return;
					}
				} catch (error) {
					fail(error as Error);
					return;
				}

				elapsed += pollMs;

				// Stop polling after timeout — task goes dormant in DB.
				// Waiter stays alive for direct wake via resolve().
				if (elapsed >= this.pollTimeoutMs) return;

				pollMs = Math.min(pollMs * 2, this.maxPollMs);
				timer = setTimeout(poll, pollMs);
			};

			const cleanup = () => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
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

			timer = setTimeout(poll, this.initialPollMs);
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

	/**
	 * Re-attach waiters for pending requests after server restart.
	 * Call this once at startup.
	 */
	recover(): number {
		const pending = this.store.listPendingNeedsHuman();
		for (const row of pending) {
			// Re-attach a waiter that polls with backoff
			this.wait(row.request_id).catch(() => {
				// Silently ignore — the task may have been abandoned
			});
		}
		return pending.length;
	}

	private getResolvedResponse(requestId: string): HumanResponse | null {
		const row = this.store.getNeedsHuman(requestId);
		if (!row || row.status !== "resolved" || !row.response) return null;
		return JSON.parse(row.response) as HumanResponse;
	}
}
