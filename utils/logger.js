const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const colors = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[35m',
  namespace: '\x1b[32m',
  reset: '\x1b[0m'
};

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const currentLevel = levels[envLevel] !== undefined ? envLevel : 'info';

function shouldLog(level) {
  return levels[level] <= levels[currentLevel];
}

function formatMeta(meta) {
  if (meta === undefined) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch (e) {
    return ' [unserializable meta]';
  }
}

function log(level, message, meta, namespace) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const color = colors[level] || '';
  const reset = colors.reset;
  const metaStr = formatMeta(meta);
  // Print to stderr for warn/error
  const nsPart = namespace ? `${colors.namespace}[${namespace}]${reset} ` : '';
  const out = `${ts} ${color}[${level.toUpperCase()}]${reset} ${nsPart}${message}${metaStr}`;
  if (level === 'error' || level === 'warn') {
    console.error(out);
  } else {
    console.log(out);
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  // convenience to create namespaced child loggers (keeps same interface)
  child: (namespace) => ({
    debug: (m, meta) => log('debug', m, meta, namespace),
    info: (m, meta) => log('info', m, meta, namespace),
    warn: (m, meta) => log('warn', m, meta, namespace),
    error: (m, meta) => log('error', m, meta, namespace)
  })
};

export default logger;
