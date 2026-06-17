import { patchJson } from "../api.ts";
import { SETTINGS_GROUPS } from "../constants.ts";
import { box, fitBodyRows, isKey, rule, truncatePlain, windowAroundSelection, wrapPlain } from "../tui.ts";
import type { Component, SettingsDisplayItem, SettingsFieldDef, Theme, TuiHandle } from "../types.ts";

export class SettingsOverlay implements Component {
	private selected = 0;
	private saving = false;
	private notice?: { kind: "info" | "warning" | "error"; text: string };
	private savedField?: string;
	private editBuffer?: string;
	private editCursor = 0;
	private pendingConfirm?: { message: string; field: SettingsFieldDef; value: unknown };
	private searchMode = false;
	private searchQuery = "";
	private rawMode: "selected" | "all" | undefined;
	private readonly expandedGroups = new Set<number>();

	constructor(
		private readonly tui: TuiHandle,
		private readonly theme: Theme,
		private readonly config: Record<string, unknown>,
		private readonly done: () => void,
	) {
		this.expandedGroups.add(0);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const boxWidth = Math.min(Math.max(72, width), 120);
		const contentWidth = Math.max(40, boxWidth - 4);
		const lines: string[] = [this.theme.fg("muted", "Global Kanade Settings"), ""];
		if (this.rawMode) return this.renderRawConfig(boxWidth, contentWidth, lines, this.rawMode);
		const displayItems = this.displayItems();
		lines.push(
			this.theme.fg(
				"dim",
				`Config: ${String((this.config.paths as Record<string, unknown>)?.configFile ?? "unknown")}`,
			),
		);
		if (this.searchMode || this.searchQuery) {
			const cursor = this.searchMode ? "▏" : "";
			lines.push(this.theme.fg("accent", `Search: ${this.searchQuery}${cursor}`));
		}
		lines.push(rule(Math.min(60, contentWidth), this.theme));

		const listRows = this.editBuffer !== undefined || this.pendingConfirm ? 10 : 16;
		const windowed = windowAroundSelection(displayItems, this.selected, listRows);
		if (windowed.start > 0) lines.push(this.theme.fg("dim", `  ... ${windowed.start} above`));
		for (let offset = 0; offset < windowed.items.length; offset++) {
			const i = windowed.start + offset;
			const item = windowed.items[offset];
			if (!item) continue;
			if (item.kind === "section") {
				const selected = i === this.selected && !this.editBuffer && !this.pendingConfirm;
				const prefix = selected ? this.theme.fg("accent", "▸") : " ";
				const marker = item.expanded ? "[-]" : "[+]";
				lines.push(
					`${prefix} ${this.theme.fg(item.expanded ? "muted" : "dim", `${marker} ${item.label}`)} ${this.theme.fg("dim", `(${item.fieldCount})`)}`,
				);
				continue;
			}
			const field = item.field;
			const value = this.getFieldValue(field.key);
			const selected = i === this.selected && !this.editBuffer && !this.pendingConfirm;
			const prefix = selected ? this.theme.fg("accent", "▸") : " ";
			const display = this.displayValue(field, value);
			const dangerTag = field.dangerous ? this.theme.fg("warning", " ⚠") : "";
			const restart = settingRequiresRestart(field.key);
			const lifecycleTag = this.theme.fg(restart ? "warning" : "dim", ` [${restart ? "restart" : "live"}]`);
			if (field.readOnly) {
				lines.push(
					`${prefix} ${this.theme.fg("dim", `${field.label}: ${display}`)}${this.theme.fg("dim", " [read-only]")}${lifecycleTag}`,
				);
			} else {
				lines.push(`${prefix} ${this.theme.fg("dim", field.label)}: ${display}${dangerTag}${lifecycleTag}`);
			}
		}
		if (windowed.end < displayItems.length)
			lines.push(this.theme.fg("dim", `  ... ${displayItems.length - windowed.end} below`));

		if (this.pendingConfirm) {
			lines.push("");
			lines.push(this.theme.fg("warning", "Confirm Change"));
			for (const line of wrapPlain(this.pendingConfirm.message, contentWidth).slice(0, 3)) {
				lines.push(this.theme.fg("dim", line));
			}
			lines.push(this.theme.fg("dim", "Enter / y confirm · Esc / n cancel"));
		}

		// Edit mode indicator
		if (this.editBuffer !== undefined) {
			lines.push("");
			const field = this.currentField();
			if (field) {
				if (field.type === "json" || field.type === "record") {
					lines.push(this.theme.fg("accent", `Editing ${field.label}:`));
					const bufLines = renderBufferWithCursor(this.editBuffer, this.editCursor);
					for (const bl of bufLines) {
						lines.push(this.theme.fg("accent", `  ${bl}`));
					}
				} else {
					const rendered = renderBufferWithCursor(this.editBuffer, this.editCursor)[0] ?? "▏";
					lines.push(this.theme.fg("accent", `Editing ${field.label}: ${rendered}`));
				}
				if (field.type === "record") {
					lines.push(this.theme.fg("dim", "One role=model per line · arrows move · Ctrl+S save · Esc cancel"));
				} else if (field.type === "json") {
					lines.push(this.theme.fg("dim", "Arrows move · Enter newline · Ctrl+S save · Esc cancel"));
				} else {
					lines.push(this.theme.fg("dim", "Arrows move · Enter save · Esc cancel"));
				}
			}
		}

		// Notice
		if (this.notice) {
			lines.push("");
			const color = this.notice.kind === "info" ? "success" : this.notice.kind;
			lines.push(this.theme.fg(color, this.notice.text));
		}

		// Saved flash
		if (this.savedField && !this.notice) {
			lines.push("");
			lines.push(this.theme.fg("success", `✓ Saved ${this.savedField}`));
		}

		lines.push("");
		if (!this.editBuffer) {
			lines.push(
				this.theme.fg(
					"dim",
					"↑↓ select · Enter expand/edit/toggle · / search · r raw selected · R raw all · Esc close",
				),
			);
		}

		const fitLines = fitBodyRows(lines, 18, 28);
		return box(fitLines, boxWidth, "Kanade Settings", this.theme);
	}

	private renderRawConfig(boxWidth: number, contentWidth: number, lines: string[], mode: "selected" | "all"): string[] {
		const target = mode === "all" ? this.rawAllTarget() : this.rawSelectedTarget();
		lines.push(this.theme.fg("dim", `Raw · ${target.label} (read-only)`));
		lines.push(rule(Math.min(60, contentWidth), this.theme));
		const raw = JSON.stringify(target.value, null, 2).split("\n");
		for (const line of raw.slice(0, 18)) lines.push(this.theme.fg("dim", truncatePlain(line, contentWidth)));
		if (raw.length > 18) lines.push(this.theme.fg("dim", `... ${raw.length - 18} more lines`));
		lines.push("");
		lines.push(this.theme.fg("dim", "r back to fields · Esc close"));
		return box(fitBodyRows(lines, 18, 28), boxWidth, "Kanade Settings", this.theme);
	}

	private rawAllTarget(): { label: string; value: unknown } {
		return { label: "config", value: this.config };
	}

	private rawSelectedTarget(): { label: string; value: unknown } {
		const item = this.currentItem();
		if (item?.kind === "field") return { label: item.field.key, value: this.getFieldValue(item.field.key) };
		if (item?.kind === "section") {
			const group = SETTINGS_GROUPS[item.groupIndex];
			if (group?.section && !group.section.startsWith("_"))
				return { label: group.section, value: this.getFieldValue(group.section) };
			if (group) {
				const value: Record<string, unknown> = {};
				for (const field of group.fields) value[field.key] = this.getFieldValue(field.key);
				return { label: group.label, value };
			}
		}
		return this.rawAllTarget();
	}

	private displayItems(): SettingsDisplayItem[] {
		const items: SettingsDisplayItem[] = [];
		const query = this.searchQuery.trim().toLowerCase();
		if (query) {
			for (let groupIndex = 0; groupIndex < SETTINGS_GROUPS.length; groupIndex++) {
				const group = SETTINGS_GROUPS[groupIndex]!;
				for (const field of group.fields) {
					const haystack = `${field.label} ${field.key} ${field.section} ${group.label}`.toLowerCase();
					if (haystack.includes(query)) items.push({ kind: "field", groupIndex, field });
				}
			}
			this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
			return items;
		}
		for (let groupIndex = 0; groupIndex < SETTINGS_GROUPS.length; groupIndex++) {
			const group = SETTINGS_GROUPS[groupIndex]!;
			const expanded = this.expandedGroups.has(groupIndex);
			items.push({ kind: "section", groupIndex, label: group.label, expanded, fieldCount: group.fields.length });
			if (expanded) {
				for (const field of group.fields) items.push({ kind: "field", groupIndex, field });
			}
		}
		this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
		return items;
	}

	private currentItem(): SettingsDisplayItem | undefined {
		return this.displayItems()[this.selected];
	}

	private currentField(): SettingsFieldDef | undefined {
		const item = this.currentItem();
		return item?.kind === "field" ? item.field : undefined;
	}

	handleInput(data: string): void {
		if (this.rawMode) {
			if (data === "r" || data === "R") {
				this.rawMode = undefined;
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
				this.done();
				return;
			}
			return;
		}

		if (this.pendingConfirm) {
			if (
				isKey(data, "escape", "\x1b") ||
				isKey(data, "ctrl+c") ||
				data === "n" ||
				data === "N" ||
				data === "q" ||
				data === "Q"
			) {
				this.pendingConfirm = undefined;
				this.notice = { kind: "warning", text: "Cancelled." };
				this.tui.requestRender();
				return;
			}
			if (data === "y" || data === "Y" || isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
				const { field, value } = this.pendingConfirm;
				this.pendingConfirm = undefined;
				void this.patchField(field.key, value);
				return;
			}
			return;
		}

		// Edit mode
		if (this.editBuffer !== undefined) {
			const field = this.currentField();
			if (field) {
				handleEditModeInput(
					data,
					this.editBuffer,
					this.editCursor,
					field,
					(buffer, cursor) => {
						this.editBuffer = buffer;
						this.editCursor = cursor;
					},
					() => {
						this.editBuffer = undefined;
						this.editCursor = 0;
					},
					() => void this.saveCurrentField(),
				);
			}
			return;
		}

		if (this.searchMode) {
			if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c")) {
				this.searchMode = false;
				this.searchQuery = "";
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
				this.selected = Math.max(0, this.selected - 1);
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
				this.selected = Math.min(this.displayItems().length - 1, this.selected + 1);
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
				this.searchMode = false;
				void this.activateField();
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "backspace")) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data <= "~") {
				this.searchQuery += data;
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			if (this.searchQuery) {
				this.searchQuery = "";
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			this.done();
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.selected = Math.max(0, this.selected - 1);
			this.notice = undefined;
			this.savedField = undefined;
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.selected = Math.min(this.displayItems().length - 1, this.selected + 1);
			this.notice = undefined;
			this.savedField = undefined;
			return;
		}
		if (data === "/") {
			this.searchMode = true;
			this.notice = undefined;
			this.savedField = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			this.rawMode = data === "R" ? "all" : "selected";
			this.notice = undefined;
			this.savedField = undefined;
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			void this.activateField();
		}
	}

	private getFieldValue(key: string): unknown {
		const parts = key.split(".");
		let current: unknown = this.config;
		for (const part of parts) {
			if (typeof current !== "object" || current === null) return undefined;
			current = (current as Record<string, unknown>)[part];
		}
		return current;
	}

	private displayValue(field: SettingsFieldDef, value: unknown): string {
		if (field.type === "boolean") return value ? "true" : "false";
		if (field.type === "record") return displayRecordValue(value);
		if (field.type === "json") {
			if (value && typeof value === "object") return JSON.stringify(value);
			return String(value ?? "{}");
		}
		return String(value ?? "");
	}

	private async activateField(): Promise<void> {
		const item = this.currentItem();
		if (item?.kind === "section") {
			if (this.expandedGroups.has(item.groupIndex)) this.expandedGroups.delete(item.groupIndex);
			else this.expandedGroups.add(item.groupIndex);
			this.notice = undefined;
			this.savedField = undefined;
			this.tui.requestRender();
			return;
		}
		const field = item?.field;
		if (!field) return;
		if (field.readOnly) {
			this.notice = { kind: "warning", text: `${field.label} is read-only.` };
			return;
		}
		if (field.type === "boolean") {
			await this.toggleBoolean(field);
		} else {
			// Enter edit mode for string/number/json
			const current = this.getFieldValue(field.key);
			if (field.type === "record") {
				this.editBuffer = formatRecordEditorValue(current);
			} else if (field.type === "json") {
				this.editBuffer = current && typeof current === "object" ? JSON.stringify(current, null, 2) : "{}";
			} else {
				this.editBuffer = String(current ?? "");
			}
			this.editCursor = this.editBuffer.length;
			this.notice = undefined;
			this.savedField = undefined;
		}
	}

	private async toggleBoolean(field: SettingsFieldDef): Promise<void> {
		const current = this.getFieldValue(field.key);
		const next = !current;

		if (field.dangerous) {
			this.pendingConfirm = {
				field,
				value: next,
				message: `${field.label}: ${current ? "true" : "false"} -> ${next ? "true" : "false"}. Confirm change?`,
			};
			this.tui.requestRender();
			return;
		}

		await this.patchField(field.key, next);
	}

	private async saveCurrentField(): Promise<void> {
		const field = this.currentField();
		if (!field) return;
		const buffer = this.editBuffer ?? "";
		let value: unknown;

		if (field.type === "number") {
			const parsed = Number(buffer);
			if (Number.isNaN(parsed)) {
				this.notice = { kind: "error", text: "Invalid number." };
				this.editBuffer = undefined;
				return;
			}
			value = parsed;
		} else if (field.type === "record") {
			try {
				value = parseRecordEditorValue(buffer);
			} catch (error) {
				this.notice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
				return;
			}
		} else if (field.type === "json") {
			try {
				value = JSON.parse(buffer);
			} catch {
				this.notice = { kind: "error", text: "Invalid JSON." };
				return;
			}
		} else {
			value = buffer;
		}

		this.editBuffer = undefined;
		this.editCursor = 0;

		if (field.dangerous) {
			this.pendingConfirm = { field, value, message: `Set ${field.label} to ${JSON.stringify(value)}. Confirm?` };
			this.tui.requestRender();
			return;
		}

		await this.patchField(field.key, value);
	}

	private async patchField(key: string, value: unknown): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.notice = undefined;
		this.savedField = undefined;
		this.tui.requestRender();
		try {
			await patchJson("/config", buildConfigPatch(key, value));
			this.notice = { kind: "info", text: `✓ Saved ${key}` };
			this.savedField = key;
			// Update local config cache
			this.setFieldValue(key, value);
		} catch (error) {
			this.notice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
		} finally {
			this.saving = false;
			this.tui.requestRender();
		}
	}

	private setFieldValue(key: string, value: unknown): void {
		const parts = key.split(".");
		let current: Record<string, unknown> = this.config;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			const next = current[part];
			if (typeof next !== "object" || next === null) {
				current[part] = {};
			}
			current = current[part] as Record<string, unknown>;
		}
		current[parts[parts.length - 1]!] = value;
	}
}

function settingRequiresRestart(key: string): boolean {
	return (
		key === "server.port" ||
		key === "server.bind" ||
		key.startsWith("paths.") ||
		key === "models.authPath" ||
		key === "models.modelsPath" ||
		key === "models.agentDir" ||
		key === "models.piAgentDir"
	);
}

function buildConfigPatch(key: string, value: unknown): Record<string, unknown> {
	const parts = key.split(".");
	if (parts.length < 2) return { [key]: value };
	const root: Record<string, unknown> = {};
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]!;
		const next: Record<string, unknown> = {};
		current[part] = next;
		current = next;
	}
	current[parts[parts.length - 1]!] = value;
	return root;
}

function displayRecordValue(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return "";
	return entries.map(([key, item]) => `${key}=${String(item ?? "")}`).join(", ");
}

function formatRecordEditorValue(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	return Object.entries(value as Record<string, unknown>)
		.map(([key, item]) => `${key}=${String(item ?? "")}`)
		.join("\n");
}

function parseRecordEditorValue(buffer: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of buffer.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const sep = line.indexOf("=");
		if (sep <= 0) throw new Error("Invalid role model line. Use role=model.");
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		if (!key) throw new Error("Role name is required.");
		result[key] = value;
	}
	return result;
}

function handleEditModeInput(
	data: string,
	buffer: string,
	cursor: number,
	field: SettingsFieldDef,
	setBuffer: (b: string, cursor: number) => void,
	cancel: () => void,
	save: () => void,
): void {
	const safeCursor = clampCursor(buffer, cursor);
	if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c")) {
		cancel();
		return;
	}
	// Ctrl+S saves (works for all field types including JSON)
	if (isKey(data, "ctrl+s") || data === "\x13") {
		save();
		return;
	}
	// For multi-line fields, Enter inserts a newline; use Ctrl+S to save
	if (
		((field.type === "json" || field.type === "record") && isKey(data, "return", "\r", "\n")) ||
		isKey(data, "enter", "\r", "\n")
	) {
		if (field.type === "json" || field.type === "record") {
			setBuffer(`${buffer.slice(0, safeCursor)}\n${buffer.slice(safeCursor)}`, safeCursor + 1);
			return;
		}
	}
	// For single-line fields, Enter saves
	if (
		field.type !== "json" &&
		field.type !== "record" &&
		(isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n"))
	) {
		save();
		return;
	}
	if (isKey(data, "left", "\x1b[D", "\x1bOD")) {
		setBuffer(buffer, Math.max(0, safeCursor - 1));
		return;
	}
	if (isKey(data, "right", "\x1b[C", "\x1bOC")) {
		setBuffer(buffer, Math.min(buffer.length, safeCursor + 1));
		return;
	}
	if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
		setBuffer(buffer, moveCursorVertically(buffer, safeCursor, -1));
		return;
	}
	if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
		setBuffer(buffer, moveCursorVertically(buffer, safeCursor, 1));
		return;
	}
	if (data === "\x1b[H" || data === "\x1b[1~") {
		setBuffer(buffer, lineStartOffset(buffer, safeCursor));
		return;
	}
	if (data === "\x1b[F" || data === "\x1b[4~") {
		setBuffer(buffer, lineEndOffset(buffer, safeCursor));
		return;
	}
	if (isKey(data, "backspace")) {
		if (safeCursor > 0) setBuffer(buffer.slice(0, safeCursor - 1) + buffer.slice(safeCursor), safeCursor - 1);
		return;
	}
	if (field.type === "number") {
		if (data === "+") {
			const n = Number(buffer);
			const next = String(Number.isNaN(n) ? 1 : n + 1);
			setBuffer(next, next.length);
			return;
		}
		if (data === "-") {
			const n = Number(buffer);
			const next = String(Number.isNaN(n) ? 0 : n - 1);
			setBuffer(next, next.length);
			return;
		}
	}
	// Allow typing printable characters
	if (data.length === 1 && data >= " " && data <= "~") {
		setBuffer(buffer.slice(0, safeCursor) + data + buffer.slice(safeCursor), safeCursor + data.length);
	}
}

function renderBufferWithCursor(buffer: string, cursor: number): string[] {
	const safeCursor = clampCursor(buffer, cursor);
	const rendered = `${buffer.slice(0, safeCursor)}▏${buffer.slice(safeCursor)}`;
	return rendered.split("\n");
}

function clampCursor(buffer: string, cursor: number): number {
	return Math.max(0, Math.min(buffer.length, cursor));
}

function lineStartOffset(buffer: string, cursor: number): number {
	const safeCursor = clampCursor(buffer, cursor);
	const previousBreak = buffer.lastIndexOf("\n", Math.max(0, safeCursor - 1));
	return previousBreak < 0 ? 0 : previousBreak + 1;
}

function lineEndOffset(buffer: string, cursor: number): number {
	const safeCursor = clampCursor(buffer, cursor);
	const nextBreak = buffer.indexOf("\n", safeCursor);
	return nextBreak < 0 ? buffer.length : nextBreak;
}

function moveCursorVertically(buffer: string, cursor: number, direction: -1 | 1): number {
	const safeCursor = clampCursor(buffer, cursor);
	const lineStart = lineStartOffset(buffer, safeCursor);
	const column = safeCursor - lineStart;
	if (direction < 0) {
		if (lineStart === 0) return safeCursor;
		const previousLineEnd = lineStart - 1;
		const previousLineStart = lineStartOffset(buffer, previousLineEnd);
		return Math.min(previousLineStart + column, previousLineEnd);
	}
	const lineEnd = lineEndOffset(buffer, safeCursor);
	if (lineEnd >= buffer.length) return safeCursor;
	const nextLineStart = lineEnd + 1;
	const nextLineEnd = lineEndOffset(buffer, nextLineStart);
	return Math.min(nextLineStart + column, nextLineEnd);
}
