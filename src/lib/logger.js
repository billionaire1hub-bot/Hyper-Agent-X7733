import { config } from "../config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const write = (level, message, fields = {}) => {
  if ((LEVELS[level] ?? 99) > threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: config.slug,
    message,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const logger = {
  error: (message, fields) => write("error", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  info: (message, fields) => write("info", message, fields),
  debug: (message, fields) => write("debug", message, fields),
  child: (base) => ({
    error: (message, fields) => write("error", message, { ...base, ...fields }),
    warn: (message, fields) => write("warn", message, { ...base, ...fields }),
    info: (message, fields) => write("info", message, { ...base, ...fields }),
    debug: (message, fields) => write("debug", message, { ...base, ...fields }),
  }),
};
