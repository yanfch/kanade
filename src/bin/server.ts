#!/usr/bin/env npx tsx
import { loadConfig } from "../config/index.ts";
import { startServer } from "../server/index.ts";

const config = loadConfig();
const server = startServer(config);
console.log(`kanade server listening on ${server.url}`);
console.log(`KANADE_DIR=${config.paths.root}`);
