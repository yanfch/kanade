import { box, isKey, wrapPlain } from "../tui.ts";
import type { Component, ConfirmDialog, Theme } from "../types.ts";

export class ConfirmOverlay implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly dialog: ConfirmDialog,
		private readonly done: (value: boolean) => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const body = [this.theme.fg(this.dialog.danger ? "warning" : "muted", this.dialog.title), ""];
		const contentWidth = Math.max(40, width - 4);
		for (const line of wrapPlain(this.dialog.message, contentWidth).slice(0, 7)) {
			body.push(this.theme.fg("dim", line));
		}
		body.push("");
		body.push(
			`${this.theme.fg(this.dialog.danger ? "error" : "warning", `Enter / y: ${this.dialog.confirmLabel}`)}    ${this.theme.fg("dim", "Esc / n: cancel")}`,
		);
		return box(body, width, "Confirm", this.theme);
	}

	handleInput(data: string): void {
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "n" || data === "N" || data === "q") {
			this.done(false);
			return;
		}
		if (data === "y" || data === "Y" || isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			this.done(true);
		}
	}
}
