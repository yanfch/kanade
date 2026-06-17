import { fetchTaskDetail } from "../api.ts";
import { agentDetailTimingLabel, agentSummaryLine, eventLabel, latestSessionModel, taskTitle } from "../format.ts";
import { box, fitBodyRows, isKey, padToRight, rule, truncateAnsi, truncatePlain } from "../tui.ts";
import type { Component, KanadeTask, SessionEvent, TaskDetail, Theme, TuiHandle } from "../types.ts";

export class AgentDetailOverlay implements Component {
	private detail?: TaskDetail;
	private error?: string;
	private loading = true;
	private disposed = false;
	private inFlight = false;
	private activityScroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly tui: TuiHandle,
		private readonly theme: Theme,
		private readonly task: KanadeTask,
		private readonly done: () => void,
		initialDetail?: TaskDetail,
		initialError?: string,
	) {
		this.detail = initialDetail;
		this.error = initialError;
		this.loading = !initialDetail && !initialError;
		if (!initialError) void this.refresh(false);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.disposed = true;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const contentWidth = Math.max(72, width - 4);
		const body: string[] = [];
		body.push(`${this.task.id} · ${taskTitle(this.task, 32)}${padToRight(this.task.status, 8)}`);
		body.push(rule(contentWidth, this.theme));
		if (this.loading) body.push(this.theme.fg("dim", "loading agent detail..."));
		if (this.error) body.push(this.theme.fg("warning", truncatePlain(this.error, contentWidth)));
		const agents = this.detail?.snapshot?.agents ?? [];
		const activeAgent = agents.find((agent) => agent.status === "running") ?? agents.at(-1);
		if (activeAgent) {
			body.push(`${this.theme.fg("muted", "Agent:")} ${activeAgent.label} · ${activeAgent.status}`);
			const summary = activeAgent.error || activeAgent.resultPreview;
			if (summary) body.push(this.theme.fg("dim", agentSummaryLine(summary, contentWidth)));
		} else {
			body.push(this.theme.fg("dim", "No agent snapshot yet."));
		}
		const timing = agentDetailTimingLabel(this.task, this.detail?.timing);
		if (timing) body.push(this.theme.fg("dim", timing));
		const sessions = this.detail?.sessions ?? [];
		if (this.detail?.sessionLabel) body.push(this.theme.fg("dim", `Session: ${this.detail.sessionLabel}`));
		else if (sessions.length > 0)
			body.push(this.theme.fg("dim", `Sessions: ${sessions.map((s) => s.label).join(", ")}`));
		const model = latestSessionModel(this.detail?.sessionEvents ?? []);
		if (model) body.push(this.theme.fg("dim", `Model: ${model}`));
		body.push(rule(contentWidth, this.theme));
		const events = this.detail?.sessionEvents ?? [];
		const visibleEvents = this.visibleActivityEvents(events, 14);
		const activityLabel =
			events.length > visibleEvents.length
				? `Activity · ${visibleEvents.start + 1}-${visibleEvents.end}/${events.length}`
				: "Activity";
		body.push(this.theme.fg("muted", activityLabel));
		if (events.length === 0) body.push(this.theme.fg("dim", "No persisted session events yet."));
		for (const event of visibleEvents.items) {
			const state = event.state === "running" ? "active" : event.state === "error" ? "!" : "·";
			body.push(truncateAnsi(`${event.time} ${state} ${eventLabel(event)} ${event.summary}`, contentWidth));
			if (event.detail) body.push(this.theme.fg("dim", truncatePlain(`    ${event.detail}`, contentWidth)));
		}
		const scrollHint = events.length > visibleEvents.items.length ? "↑↓ scroll · PgUp/PgDn page · " : "";
		body.push(this.theme.fg("dim", `${scrollHint}r refresh · Esc close`));
		this.cachedWidth = width;
		this.cachedLines = box(fitBodyRows(body, 24, 27), width, "Kanade Agent Detail", this.theme);
		return this.cachedLines;
	}

	handleInput(data: string): void {
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.dispose();
			this.done();
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.scrollActivity(1);
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.scrollActivity(-1);
			return;
		}
		if (isKey(data, "pageup", "\x1b[5~")) {
			this.scrollActivity(8);
			return;
		}
		if (isKey(data, "pagedown", "\x1b[6~")) {
			this.scrollActivity(-8);
			return;
		}
		if (isKey(data, "home", "\x1b[H", "\x1b[1~")) {
			this.activityScroll = Math.max(0, (this.detail?.sessionEvents?.length ?? 0) - 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "end", "\x1b[F", "\x1b[4~")) {
			this.activityScroll = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") void this.refresh(true);
	}

	private visibleActivityEvents(
		events: SessionEvent[],
		limit: number,
	): { items: SessionEvent[]; start: number; end: number } {
		if (events.length === 0) return { items: [], start: 0, end: 0 };
		const maxScroll = Math.max(0, events.length - 1);
		this.activityScroll = Math.min(Math.max(0, this.activityScroll), maxScroll);
		const end = Math.max(0, events.length - this.activityScroll);
		const start = Math.max(0, end - limit);
		return { items: events.slice(start, end), start, end };
	}

	private scrollActivity(delta: number): void {
		const eventCount = this.detail?.sessionEvents?.length ?? 0;
		if (eventCount === 0) return;
		this.activityScroll = Math.min(Math.max(0, this.activityScroll + delta), Math.max(0, eventCount - 1));
		this.invalidate();
		this.tui.requestRender();
	}

	private async refresh(showLoading: boolean): Promise<void> {
		if (this.disposed || this.inFlight) return;
		this.inFlight = true;
		if (showLoading) this.loading = true;
		this.activityScroll = 0;
		this.error = undefined;
		this.invalidate();
		this.tui.requestRender();
		try {
			this.detail = await fetchTaskDetail(this.task.id, true);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.inFlight = false;
			this.loading = false;
			if (!this.disposed) {
				this.invalidate();
				this.tui.requestRender();
			}
		}
	}
}
