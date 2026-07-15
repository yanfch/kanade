import { fetchScheduleRuns, fetchSchedules } from "../api.ts";
import { box, fitBodyRows, isKey, padAnsi, rule, truncateAnsi, truncatePlain, windowAroundSelection } from "../tui.ts";
import type { Component, KanadeSchedule, KanadeScheduleRun, Theme, TuiHandle } from "../types.ts";

export class ScheduleOverlay implements Component {
	private schedules: KanadeSchedule[] = [];
	private runs: KanadeScheduleRun[] = [];
	private selected = 0;
	private loading = true;
	private runsLoading = false;
	private error?: string;
	private runsError?: string;
	private disposed = false;
	private runsLoadSeq = 0;

	constructor(
		private readonly tui: TuiHandle,
		private readonly theme: Theme,
		private readonly done: () => void,
	) {
		void this.refresh();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const boxWidth = Math.min(Math.max(72, width), 132);
		const contentWidth = Math.max(40, boxWidth - 4);
		const enabled = this.schedules.filter((schedule) => schedule.enabled).length;
		const body: string[] = [
			`${this.theme.fg("muted", `Schedules (${this.schedules.length})`)}  ${this.theme.fg("success", `${enabled} enabled`)}  ${this.theme.fg("dim", `${this.schedules.length - enabled} paused`)}`,
			rule(contentWidth, this.theme),
		];

		if (this.loading) {
			body.push(this.theme.fg("dim", "Loading schedules..."));
		} else if (this.error) {
			body.push(this.theme.fg("error", truncatePlain(this.error, contentWidth)));
		} else if (this.schedules.length === 0) {
			body.push(this.theme.fg("dim", "No schedules configured."));
			body.push(this.theme.fg("dim", "Create one with: kanade schedule add ..."));
		} else if (contentWidth >= 90) {
			this.renderWide(body, contentWidth);
		} else {
			this.renderNarrow(body, contentWidth);
		}

		body.push(rule(contentWidth, this.theme));
		body.push(this.theme.fg("dim", "↑↓ select · r refresh · Esc close"));
		return box(fitBodyRows(body, 22, 29), boxWidth, "Kanade Schedules", this.theme);
	}

	handleInput(data: string): void {
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.disposed = true;
			this.done();
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.select(this.selected - 1);
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.select(this.selected + 1);
			return;
		}
		if (data === "r" || data === "R") void this.refresh();
	}

	private renderWide(body: string[], width: number): void {
		const leftWidth = Math.min(40, Math.max(32, Math.floor(width * 0.36)));
		const rightWidth = width - leftWidth - 3;
		const list = this.scheduleLines(leftWidth, 7);
		const detail = this.detailLines(rightWidth);
		const rows = Math.max(list.length, detail.length, 17);
		for (let i = 0; i < rows; i++) {
			body.push(
				`${padAnsi(list[i] ?? "", leftWidth)} ${this.theme.fg("dim", "│")} ${truncateAnsi(detail[i] ?? "", rightWidth)}`,
			);
		}
	}

	private renderNarrow(body: string[], width: number): void {
		body.push(...this.scheduleLines(width, 4));
		body.push(rule(width, this.theme));
		body.push(...this.detailLines(width));
	}

	private scheduleLines(width: number, limit: number): string[] {
		const lines = [this.theme.fg("muted", "Schedule list")];
		const windowed = windowAroundSelection(this.schedules, this.selected, limit);
		if (windowed.start > 0) lines.push(this.theme.fg("dim", `  ... ${windowed.start} above`));
		for (let offset = 0; offset < windowed.items.length; offset++) {
			const schedule = windowed.items[offset];
			if (!schedule) continue;
			const index = windowed.start + offset;
			const selected = index === this.selected;
			const prefix = selected ? this.theme.fg("accent", "▸") : " ";
			const state = schedule.enabled ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
			const name = selected
				? this.theme.fg("warning", truncatePlain(schedule.name, Math.max(8, width - 6)))
				: truncatePlain(schedule.name, Math.max(8, width - 6));
			lines.push(`${prefix} ${state} ${name}`);
			const next = schedule.enabled ? timeFromNow(schedule.next_run_at) : "paused";
			lines.push(this.theme.fg("dim", truncatePlain(`    ${schedule.cron} · ${next}`, width)));
		}
		if (windowed.start + windowed.items.length < this.schedules.length) {
			lines.push(this.theme.fg("dim", `  ... ${this.schedules.length - windowed.start - windowed.items.length} below`));
		}
		return lines;
	}

	private detailLines(width: number): string[] {
		const schedule = this.schedules[this.selected];
		if (!schedule) return [this.theme.fg("dim", "Select a schedule.")];
		const state = schedule.enabled ? this.theme.fg("success", "enabled") : this.theme.fg("warning", "paused");
		const lines = [
			`${this.theme.fg("muted", schedule.name)} · ${state}`,
			this.theme.fg("dim", truncatePlain(schedule.id, width)),
			"",
			`Cron: ${schedule.cron}`,
			`Timezone: ${schedule.timezone}`,
			`Next: ${schedule.enabled ? `${formatScheduleTime(schedule.next_run_at, schedule.timezone)} (${timeFromNow(schedule.next_run_at)})` : "paused"}`,
			`Policies: overlap ${schedule.overlap_policy} · misfire ${schedule.misfire_policy}`,
			"",
			`${this.theme.fg("muted", "Task")}: ${schedule.task.workflow_name}`,
			`Cwd: ${schedule.task.options?.cwd ?? "server default"}`,
		];
		const args = jsonSummary(schedule.task.args);
		if (args) lines.push(`Args: ${truncatePlain(args, Math.max(8, width - 6))}`);
		const pi = piSummary(schedule);
		if (pi) lines.push(`Pi: ${truncatePlain(pi, Math.max(8, width - 4))}`);
		const skills = schedule.task.options?.pi?.skill_paths ?? [];
		if (skills.length > 0) {
			lines.push(`Skills (${skills.length}):`);
			for (const path of skills.slice(0, 3)) lines.push(this.theme.fg("dim", truncatePlain(`  ${path}`, width)));
			if (skills.length > 3) lines.push(this.theme.fg("dim", `  ... ${skills.length - 3} more`));
		}
		lines.push("", this.theme.fg("muted", "Recent runs"));
		if (this.runsLoading) lines.push(this.theme.fg("dim", "Loading runs..."));
		else if (this.runs.length === 0) lines.push(this.theme.fg("dim", "No runs yet."));
		else {
			for (const run of this.runs.slice(0, 6)) lines.push(this.runLine(run, width, schedule.timezone));
		}
		if (this.runsError) lines.push(this.theme.fg("warning", truncatePlain(this.runsError, width)));
		return lines;
	}

	private runLine(run: KanadeScheduleRun, width: number, timezone: string): string {
		const icon =
			run.status === "launched"
				? this.theme.fg("success", "✓")
				: run.status === "skipped"
					? this.theme.fg("warning", "-")
					: run.status === "failed"
						? this.theme.fg("error", "×")
						: this.theme.fg("accent", "·");
		const target = run.task_id ?? run.reason ?? run.status;
		return truncateAnsi(
			`${icon} ${formatScheduleTime(run.scheduled_for, timezone)} · ${run.status} · ${target}`,
			width,
		);
	}

	private select(index: number): void {
		const next = Math.min(Math.max(0, index), Math.max(0, this.schedules.length - 1));
		if (next === this.selected) return;
		this.selected = next;
		this.runs = [];
		this.runsError = undefined;
		this.tui.requestRender();
		void this.loadRuns();
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		this.loading = true;
		this.error = undefined;
		this.runsError = undefined;
		this.tui.requestRender();
		try {
			this.schedules = await fetchSchedules();
			this.selected = Math.min(this.selected, Math.max(0, this.schedules.length - 1));
		} catch (error) {
			this.schedules = [];
			this.runs = [];
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			if (!this.disposed) this.tui.requestRender();
		}
		if (!this.error) await this.loadRuns();
	}

	private async loadRuns(): Promise<void> {
		const schedule = this.schedules[this.selected];
		const seq = ++this.runsLoadSeq;
		if (!schedule || this.disposed) return;
		this.runsLoading = true;
		this.runsError = undefined;
		this.tui.requestRender();
		try {
			const runs = await fetchScheduleRuns(schedule.id);
			if (seq === this.runsLoadSeq && schedule.id === this.schedules[this.selected]?.id) this.runs = runs;
		} catch (error) {
			if (seq === this.runsLoadSeq) {
				this.runs = [];
				this.runsError = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (seq === this.runsLoadSeq) this.runsLoading = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}
}

function timeFromNow(ts: number): string {
	const seconds = Math.round((ts - Date.now()) / 1000);
	const abs = Math.abs(seconds);
	const value =
		abs < 60
			? `${abs}s`
			: abs < 3600
				? `${Math.round(abs / 60)}m`
				: abs < 86_400
					? `${Math.round(abs / 3600)}h`
					: `${Math.round(abs / 86_400)}d`;
	return seconds >= 0 ? `in ${value}` : `${value} ago`;
}

function formatScheduleTime(ts: number, timezone?: string): string {
	const options: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	};
	if (timezone) options.timeZone = timezone;
	const parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(new Date(ts));
	const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
	return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function jsonSummary(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function piSummary(schedule: KanadeSchedule): string {
	const pi = schedule.task.options?.pi;
	if (!pi) return "";
	return [
		pi.thinking_level ? `thinking=${pi.thinking_level}` : "",
		pi.tools?.length ? `tools=${pi.tools.join(",")}` : "",
		pi.exclude_tools?.length ? `exclude=${pi.exclude_tools.join(",")}` : "",
		pi.no_tools ? `no_tools=${pi.no_tools}` : "",
	]
		.filter(Boolean)
		.join(" · ");
}
