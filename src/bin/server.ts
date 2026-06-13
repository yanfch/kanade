#!/usr/bin/env npx tsx
import { loadConfig } from "../config/index.ts";
import { configureHttpDispatcher } from "../net/http-dispatcher.ts";
import { startServer } from "../server/index.ts";
import { createMockSessionFactory } from "../server/test-session-mock.ts";

const config = loadConfig();
configureHttpDispatcher(config.network);
const mockSessionText = process.env.KANADE_MOCK_SESSION_TEXT?.trim();
const mockUsageJson = process.env.KANADE_MOCK_SESSION_USAGE?.trim();
let mockUsage:
	| {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	  }
	| undefined;
if (mockUsageJson) {
	try {
		mockUsage = JSON.parse(mockUsageJson);
	} catch {
		console.error("KANADE_MOCK_SESSION_USAGE is not valid JSON, ignoring");
	}
}
const sessionFactory = mockSessionText
	? createMockSessionFactory({ text: mockSessionText, ...(mockUsage ? { usage: mockUsage } : {}) }).createSession
	: undefined;
const server = startServer(config, sessionFactory);
console.log(`kanade server listening on ${server.url}`);
console.log(`KANADE_DIR=${config.paths.root}`);
