#!/usr/bin/env node
/**
 * kanade server — starts HTTP API + workflow runtime.
 * To be implemented. See ../server/README.md.
 */
import { loadConfig } from "../config/index.ts";

const config = loadConfig();
console.log(`kanade server stub — would start on ${config.server.bind}:${config.server.port}`);
console.log(`KANADE_DIR=${config.paths.root}`);
