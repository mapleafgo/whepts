/**
 * 错误类型
 */
export type ErrorType = string

/**
 * 错误类型常量
 */
export const ErrorTypes = {
  SIGNAL_ERROR: 'SignalError', // 信令异常
  STATE_ERROR: 'StateError', // 状态异常
  REQUEST_ERROR: 'RequestError', // 请求异常
  NOT_FOUND_ERROR: 'NotFoundError', // 没有找到
  CONNECT_ERROR: 'ConnectError', // 连接异常
  MEDIA_ERROR: 'MediaError',
  OTHER_ERROR: 'OtherError',
}

/**
 * 错误
 */
export class WebRTCError extends Error {
  type: ErrorType

  constructor(type: ErrorType, message: string, options?: ErrorOptions) {
    super(message, options)
    this.type = type
  }
}
