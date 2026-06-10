import * as undici from "undici";

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

function parseTimeoutMs(value: string | undefined): number {
	if (!value?.trim()) return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_HTTP_IDLE_TIMEOUT_MS;
}

function mirrorProxyEnv(upper: string, lower: string): void {
	if (!process.env[upper] && process.env[lower]) process.env[upper] = process.env[lower];
	if (!process.env[lower] && process.env[upper]) process.env[lower] = process.env[upper];
}

/**
 * Configure Node/undici fetch and websocket traffic to honor HTTP(S)_PROXY / ALL_PROXY.
 *
 * Pi's CLI calls its own dispatcher setup before provider requests. Kanade embeds Pi via
 * the SDK, so we need to perform equivalent initialization in our process as well.
 */
export function configureHttpDispatcher(): void {
	mirrorProxyEnv("HTTP_PROXY", "http_proxy");
	mirrorProxyEnv("HTTPS_PROXY", "https_proxy");
	mirrorProxyEnv("ALL_PROXY", "all_proxy");
	mirrorProxyEnv("NO_PROXY", "no_proxy");

	const timeoutMs = parseTimeoutMs(process.env.KANADE_HTTP_IDLE_TIMEOUT_MS);
	undici.setGlobalDispatcher(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: timeoutMs,
			headersTimeout: timeoutMs,
		}),
	);
	undici.install?.();
}
