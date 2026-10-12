import type { Clock, Logger } from "./ports.ts";

export const systemClock: Clock = { now: () => Date.now() };

/** One JSON object per line: `{level, event, ...fields}`. Never free-form strings. */
export const consoleLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: "info", event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: "warn", event, ...fields })),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };
