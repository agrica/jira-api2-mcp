#!/usr/bin/env node
// Process entry point: wiring only, tested by spawning it (src/index.test.ts); the logic is in main.ts.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { main } from './main.ts';

const code = await main({
  env: process.env,
  log: (line) => console.error(line),
  serve: serveStdio,
});
if (code !== 0) process.exit(code);
