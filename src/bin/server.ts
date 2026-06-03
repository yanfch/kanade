#!/usr/bin/env npx tsx
import { loadConfig } from "../config/index.ts";
import { startServer } from "../server/index.ts";
import { createMockSessionFactory } from "../server/test-session-mock.ts";

const config = loadConfig();
const mockSessionText = process.env.KANADE_MOCK_SESSION_TEXT?.trim();
const sessionFactory = mockSessionText ? createMockSessionFactory({ text: mockSessionText }).createSession : undefined;
const server = startServer(config, sessionFactory);
console.log(`kanade server listening on ${server.url}`);
console.log(`KANADE_DIR=${config.paths.root}`);
