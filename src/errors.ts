/**
 * 错误类型
 */
export type ErrorType = string;

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "InvalidStateError",
  "InvalidAccessError",
  "NotAllowedError",
  "NotSupportedError",
  "OperationError",
  "NetworkError",
  "SecurityError",
]);

/** Return a recognized error name without exposing arbitrary exception text. */
export function safeErrorName(error: unknown): string {
  try {
    const name = error instanceof Error ? error.name : undefined;
    if (typeof name === "string" && SAFE_ERROR_NAMES.has(name)) return name;
  } catch {
    // 调用方提供的异常对象可能有抛错的属性访问器。
  }
  return "unknown";
}

export type ErrorPhase = "configuration" | "signaling" | "connection";

interface WebRTCErrorOptions extends ErrorOptions {
  phase?: ErrorPhase;
  reason?: "setup-timeout";
  httpStatus?: number;
  retryAt?: number;
}

/**
 * 错误类型常量
 *
 * 错误分类：
 * - SIGNAL_ERROR: 信令异常（SDP、ICE 服务器）
 * - STATE_ERROR: 状态异常（播放器已关闭等）
 * - REQUEST_ERROR: 请求异常（400、406 等错误状态码）
 * - NOT_FOUND_ERROR: 保留的导出值；HTTP 状态码统一通过 httpStatus 表达
 *
 * 注意：流连接断开已由 `flow:stalled` 事件独立处理，不作为错误类型。
 */
export const ErrorTypes = {
  SIGNAL_ERROR: "SignalError", // 信令异常
  STATE_ERROR: "StateError", // 状态异常
  REQUEST_ERROR: "RequestError", // 请求异常
  NOT_FOUND_ERROR: "NotFoundError", // 没有找到
  VIDEO_ERROR: "VideoError", // 播放容器错误
  OTHER_ERROR: "OtherError", // 其他错误
};

/**
 * 错误
 */
export class WebRTCError extends Error {
  type: ErrorType;

  declare readonly phase?: ErrorPhase;
  declare readonly reason?: "setup-timeout";
  declare readonly httpStatus?: number;
  /** Earliest permitted retry time, in Unix milliseconds, when provided by the endpoint. */
  declare readonly retryAt?: number;

  constructor(type: ErrorType, message: string, options?: WebRTCErrorOptions) {
    super(message, options);
    this.type = type;
    if (options?.reason !== undefined) this.reason = options.reason;
    if (options?.phase !== undefined) this.phase = options.phase;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.retryAt !== undefined) this.retryAt = options.retryAt;
  }
}
