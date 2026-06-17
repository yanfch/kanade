import { box, isKey } from "../tui.ts";
import type { ActionItem, Component, Theme } from "../types.ts";

export class ActionMenuOverlay implements Component {
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly theme: Theme,
		private readonly taskId: string,
		private readonly items: ActionItem[],
		private readonly done: (value: ActionItem | null) => void,
	) {}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const body = [this.theme.fg("muted", `Actions · ${this.taskId}`), ""];
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const prefix = i === this.selected ? this.theme.fg("accent", "▸") : " ";
			const label = item.danger ? this.theme.fg("warning", item.label) : item.label;
			body.push(`${prefix} ${label}`);
		}
		body.push("");
		body.push(this.theme.fg("dim", "↑↓ select · Enter run · Esc cancel"));
		this.cachedWidth = width;
		this.cachedLines = box(body, Math.min(width, 58), "Kanade Actions", this.theme);
		return this.cachedLines;
	}

	handleInput(data: string): void {
		this.cachedLines = undefined;
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.done(null);
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.selected = Math.min(Math.max(0, this.items.length - 1), this.selected + 1);
			return;
		}
		if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			this.done(this.items[this.selected] ?? null);
		}
	}
}
