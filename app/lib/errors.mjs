/**
 * Uniform error contract for the local HTTP API.
 *
 * Every failure returns `{ ok: false, code, error, hint }`. `code` is a stable
 * machine-readable value (never a Node errno), so the UI, the CLI and the
 * troubleshooting docs can agree on what happened instead of matching on
 * Chinese message text that changes whenever the wording is improved.
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, hint = '' } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export const ERROR_CODES = {
  INVALID: 'E_INVALID',
  BUSY: 'E_BUSY',
  UNKNOWN_ACTION: 'E_UNKNOWN_ACTION',
  NOT_FOUND: 'E_NOT_FOUND',
  FORBIDDEN: 'E_FORBIDDEN',
  TOO_LARGE: 'E_TOO_LARGE',
  CONTENT_TYPE: 'E_CONTENT_TYPE',
  DISK_FULL: 'E_DISK_FULL',
  INTERNAL: 'E_INTERNAL',
};

const BY_STATUS = {
  400: ERROR_CODES.INVALID,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.BUSY,
  413: ERROR_CODES.TOO_LARGE,
  415: ERROR_CODES.CONTENT_TYPE,
  507: ERROR_CODES.DISK_FULL,
};

const DEFAULT_HINTS = {
  [ERROR_CODES.DISK_FULL]: '请清理磁盘或修改安装目录，已下载的断点会保留。',
  [ERROR_CODES.BUSY]: '等当前任务结束，或先在任务栏点「取消」。',
  [ERROR_CODES.FORBIDDEN]: '只允许从本机页面访问这个服务。',
  [ERROR_CODES.INTERNAL]: '详情已写入 logs/server.log。如果页面同时提示 Failed to fetch，请确认启动窗口未关闭。',
};

/** Node errno values (`ENOENT`, `EBUSY`, ...) must not leak out as API codes. */
function appCode(err, status) {
  const code = err?.code;
  if (typeof code === 'string' && /^E_[A-Z_]+$/.test(code)) return code;
  if (code === 'ENOSPC') return ERROR_CODES.DISK_FULL;
  if (BY_STATUS[status]) return BY_STATUS[status];
  // Any unlisted status still needs a stable code: 4xx is the caller's fault,
  // 5xx is ours. Without this, a 422 fell through to E_INTERNAL.
  return status >= 500 ? ERROR_CODES.INTERNAL : ERROR_CODES.INVALID;
}

/**
 * Runtime errors that a user cannot act on. Validation code in this package
 * throws plain `Error('…')` with a readable message, so only the engine-level
 * error types are treated as internal faults. Without this distinction a
 * TypeError inside an action was reported as `400 E_INVALID`, which told the
 * user "your input is wrong" for what is actually a bug in the console.
 */
const INTERNAL_TYPES = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError']);

function isInternalFault(err) {
  return err instanceof Error && INTERNAL_TYPES.has(err.name);
}

function resolveStatus(err, forced) {
  const explicit = Number(forced) || Number(err?.status);
  if (explicit) return explicit;
  if (err?.code === 'ENOSPC') return 507;
  return isInternalFault(err) ? 500 : 400;
}

export function errorPayload(err, { status: forcedStatus } = {}) {
  const status = resolveStatus(err, forcedStatus);
  const code = appCode(err, status);
  const message = err instanceof Error ? err.message : String(err ?? '未知错误');
  return {
    ok: false,
    code,
    status,
    error: message,
    hint: (err instanceof AppError ? err.hint : '') || DEFAULT_HINTS[code] || '',
  };
}
