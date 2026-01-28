/**
 * 错误类型
 */
export type ErrorType = string

/**
 * 错误类型常量
 *
 * 错误分类：
 * - SIGNAL_ERROR: 信令异常（SDP、ICE 服务器）
 * - STATE_ERROR: 状态异常（播放器已关闭等）
 * - REQUEST_ERROR: 请求异常（400、406 等错误状态码）
 * - NOT_FOUND_ERROR: 资源未找到（404）
 *
 * 注意：流连接断开已由 `flow:stalled` 事件独立处理，不作为错误类型。
 */
export const ErrorTypes = {
  SIGNAL_ERROR: 'SignalError', // 信令异常
  STATE_ERROR: 'StateError', // 状态异常
  REQUEST_ERROR: 'RequestError', // 请求异常
  NOT_FOUND_ERROR: 'NotFoundError', // 没有找到
  OTHER_ERROR: 'OtherError', // 其他错误
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
