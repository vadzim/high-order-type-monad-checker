#!/usr/bin/env node

import { runCli } from "./run-check-monad.ts"

process.exitCode = await runCli(process.argv.slice(2))
