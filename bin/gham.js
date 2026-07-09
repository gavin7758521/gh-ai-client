#!/usr/bin/env node
import { main } from "../src/cli.js";
import { basename } from "node:path";

main(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${basename(process.argv[1] || "gham")}: ${message}`);
  process.exitCode = 1;
});
