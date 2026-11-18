type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON lines on stdout. Never pass request bodies or Authorization values in fields. */
export function createLogger(level: Level = 'info', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (lvl: Level) => (msg: string, fields: Record<string, unknown> = {}) => {
    if (order[lvl] < order[level]) return;
    const out: Record<string, unknown> = { t: new Date().toISOString(), level: lvl, msg, ...fields };
    if (fields.err instanceof Error) out.err = { name: fields.err.name, message: fields.err.message };
    sink(JSON.stringify(out));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
