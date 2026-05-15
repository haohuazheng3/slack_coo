type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[CURRENT_LEVEL];
}

function emit(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${scope}]`;
  if (meta) {
    console.log(`${prefix} ${message}`, JSON.stringify(meta));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: Record<string, unknown>) => emit('debug', scope, message, meta),
    info: (message: string, meta?: Record<string, unknown>) => emit('info', scope, message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => emit('warn', scope, message, meta),
    error: (message: string, meta?: Record<string, unknown>) => emit('error', scope, message, meta),
  };
}
