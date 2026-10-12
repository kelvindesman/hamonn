#!/usr/bin/env -S npx tsx
import { main } from "./cli.ts";
import { defaultIo } from "./io.ts";

process.exitCode = await main(process.argv.slice(2), defaultIo());
