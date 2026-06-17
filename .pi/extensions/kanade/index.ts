import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KanadePanel, updateFooterStatus } from "./components/kanade-panel.ts";

export default function kanadeExtension(pi: ExtensionAPI) {
	let statusTimer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await updateFooterStatus(ctx);
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = setInterval(() => void updateFooterStatus(ctx), 10_000);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("kanade", undefined);
	});

	pi.registerCommand("kanade", {
		description: "Open the Kanade cockpit",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/kanade requires Pi TUI mode", "error");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const panel = new KanadePanel(tui, theme, ctx.ui, done);
					void panel.refresh();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "94%",
						minWidth: 96,
						maxHeight: "86%",
						anchor: "top-center",
						offsetY: 1,
						margin: 1,
					},
				},
			);
		},
	});
}
