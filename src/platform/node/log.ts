// One JSON line per call, like void/log, so `voidbase serve` logs stay greppable
const line = (level: string, message: string, fields?: Record<string, unknown>) => console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](JSON.stringify({ level, message, time: new Date().toISOString(), ...(fields ?? {}) }));
export const logger = {
  error: (message: string, fields?: Record<string, unknown>) => line("error", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => line("warn", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => line("info", message, fields),
};
