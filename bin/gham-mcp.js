#!/usr/bin/env node
import { runMcpServer } from "../src/mcp-server.js";
import { basename } from "node:path";

runMcpServer().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${basename(process.argv[1] || "gham-mcp")}: ${message}`);
  process.exitCode = 1;
});
