#!/usr/bin/env node

import process from "node:process";
import { runCli } from "../cli/program.js";

const ctx = {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  output(): never {
    throw new Error("output() called before runCli bound it");
  },
};

process.exitCode = await runCli(process.argv.slice(2), ctx);
