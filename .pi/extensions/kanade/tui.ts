import { matchesKey } from "@earendil-works/pi-tui";
import { ANSI_SGR_GLOBAL, ANSI_SGR_PREFIX, CLEAR_CELL } from "./constants.ts";
import type { Theme } from "./types.ts";

export function padToRight(text: string, pad: number): string {
	return `${" ".repeat(Math.max(1, pad))}${text}`;
}

export function rule(width: number, theme: Theme): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

export function normalizeBodyRows(body: string[], rows: number, _width: number, _theme: Theme): string[] {
	const noticeRuleIndex = body.length >= 3 && isRuleText(body.at(-3) ?? "") ? body.length - 3 : -1;
	const footer = noticeRuleIndex >= 0 ? body.slice(noticeRuleIndex) : [body.at(-1) ?? ""];
	const content = noticeRuleIndex >= 0 ? body.slice(0, noticeRuleIndex) : body.slice(0, -1);
	const contentRows = Math.max(0, rows - footer.length);
	if (content.length < contentRows) {
		return [...content, ...Array.from({ length: contentRows - content.length }, () => ""), ...footer];
	}
	if (content.length === contentRows) return [...content, ...footer];
	return [...content.slice(0, contentRows), ...footer];
}

export function isRuleText(text: string): boolean {
	const plain = stripAnsi(text).trim();
	return plain.length > 0 && /^─+$/.test(plain);
}

export function fitBodyRows(body: string[], minRows: number, maxRows: number): string[] {
	const help = body.at(-1) ?? "";
	let content = body.slice(0, -1);
	if (content.length > maxRows - 1) content = content.slice(0, Math.max(0, maxRows - 1));
	if (content.length < minRows - 1)
		content = [...content, ...Array.from({ length: minRows - 1 - content.length }, () => "")];
	return [...content, help];
}

export function windowAroundSelection<T>(
	items: T[],
	selected: number,
	size: number,
): { items: T[]; start: number; end: number } {
	if (items.length <= size) return { items, start: 0, end: items.length };
	const half = Math.floor(size / 2);
	let start = Math.max(0, selected - half);
	start = Math.min(start, Math.max(0, items.length - size));
	const end = Math.min(items.length, start + size);
	return { items: items.slice(start, end), start, end };
}

export function box(body: string[], width: number, title: string, theme: Theme): string[] {
	const inner = Math.max(10, width - 4);
	const borderInner = inner + 2;
	const titleText = ` ${title} `;
	const topRight = Math.max(0, borderInner - visibleWidth(titleText));
	const top = `╭${"─".repeat(2)}${titleText}${"─".repeat(Math.max(0, topRight - 2))}╮`;
	const bottom = `╰${"─".repeat(borderInner)}╯`;
	return [theme.fg("muted", top), ...body.map((line) => `│ ${padAnsi(line, inner)} │`), theme.fg("muted", bottom)];
}

export function padAnsi(text: string, width: number): string {
	const clipped = truncateAnsi(text, width);
	return clipped + CLEAR_CELL.repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function truncateAnsi(text: string, maxWidth: number, suffix = "…"): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const target = Math.max(0, maxWidth - visibleWidth(suffix));
	let width = 0;
	let out = "";
	for (let i = 0; i < text.length; ) {
		if (text.charCodeAt(i) === 27) {
			const match = ANSI_SGR_PREFIX.exec(text.slice(i));
			if (match) {
				out += match[0];
				i += match[0].length;
				continue;
			}
		}
		const cp = text.codePointAt(i) ?? 0;
		const char = String.fromCodePoint(cp);
		const w = charWidth(cp);
		if (width + w > target) break;
		out += char;
		width += w;
		i += char.length;
	}
	return out + suffix;
}

export function truncatePlain(text: string, maxWidth: number): string {
	return stripAnsi(truncateAnsi(text, maxWidth));
}

export function wrapPlain(text: string, width: number): string[] {
	const plain = stripAnsi(text);
	const words = plain.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (visibleWidth(candidate) <= width) current = candidate;
		else {
			if (current) lines.push(current);
			let rest = word;
			while (visibleWidth(rest) > width) {
				lines.push(truncatePlain(rest, Math.max(1, width)));
				rest = rest.slice(stripAnsi(lines.at(-1) ?? "").length).trimStart();
			}
			current = rest;
		}
	}
	if (current) lines.push(current);
	return lines.length ? lines : [""];
}

export function visibleWidth(text: string): number {
	const stripped = stripAnsi(text);
	let width = 0;
	for (let i = 0; i < stripped.length; ) {
		const cp = stripped.codePointAt(i) ?? 0;
		width += charWidth(cp);
		i += cp > 0xffff ? 2 : 1;
	}
	return width;
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR_GLOBAL, "");
}

export function charWidth(cp: number): number {
	if (cp === 0) return 0;
	if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6)
	) {
		return 2;
	}
	return 1;
}

export function isKey(data: string, key: Parameters<typeof matchesKey>[1], ...fallbacks: string[]): boolean {
	return matchesKey(data, key) || fallbacks.includes(data);
}
