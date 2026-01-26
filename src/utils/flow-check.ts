import type EventEmitter from 'eventemitter3'
import { ErrorTypes, WebRTCError } from '~/errors'

export interface FlowCheckOptions {
  interval: number
  stableInterval?: number
  maxNoProgress?: number
  stabilizationTime?: number
  emitter: EventEmitter
}

/**
 * Flow checking logic (断流检测)
 *
 * 性能优化：自适应轮询机制
 * - 初始阶段（stabilizationTime）：高频检查（interval）
 * - 稳定阶段：降低频率（stableInterval，默认为 interval 的 2 倍）
 * - 使用 setTimeout 而非 setInterval，便于动态调整间隔
 * - 连续多次（maxNoProgress）无进展才判定断流，避免误判
 */
export class FlowCheck {
  private baseInterval: number
  private stableInterval: number
  private maxNoProgress: number
  private stabilizationTime: number
  private lastBytesReceived: number = 0
  private checkTimer?: ReturnType<typeof setTimeout>
  private pc?: RTCPeerConnection

  // 状态跟踪
  private consecutiveNoProgress: number = 0
  private startTime: number = 0
  private isStable: boolean = false

  constructor(private options: FlowCheckOptions) {
    this.baseInterval = options.interval
    this.stableInterval = options.stableInterval || (options.interval * 2)
    this.maxNoProgress = options.maxNoProgress || 3
    this.stabilizationTime = options.stabilizationTime || 30000 // 30秒
  }

  setPeerConnection(pc: RTCPeerConnection | undefined): void {
    this.pc = pc
  }

  /**
   * 启动断流检测
   */
  start(): void {
    this.close()
    this.startTime = Date.now()
    this.isStable = false
    this.consecutiveNoProgress = 0
    this.scheduleNextCheck()
  }

  /**
   * 停止断流检测并清理资源
   */
  close(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer)
      this.checkTimer = undefined
    }
    this.pc = undefined
  }

  /**
   * 调度下一次检查
   */
  private scheduleNextCheck(): void {
    const interval = this.getNextCheckInterval()
    this.checkTimer = setTimeout(() => {
      this.checkFlowState().then(() => {
        // 只在连接状态下继续检查
        if (this.pc && this.pc.connectionState === 'connected') {
          this.scheduleNextCheck()
        }
      })
    }, interval)
  }

  /**
   * 计算下次检查间隔
   */
  private getNextCheckInterval(): number {
    const elapsedTime = Date.now() - this.startTime
    this.isStable = elapsedTime > this.stabilizationTime
    return this.isStable ? this.stableInterval : this.baseInterval
  }

  /**
   * 检测流状态（通过接收字节数判断是否断流）
   */
  private async checkFlowState(): Promise<void> {
    if (!this.pc) {
      return
    }

    // 只在 connected 状态下检查
    if (this.pc.connectionState !== 'connected') {
      return
    }

    const stats = await this.pc.getStats()
    let currentBytes = 0

    // 遍历统计信息，获取视频接收字节数
    stats.forEach((stat: RTCStats) => {
      const inboundRtpStat = stat as RTCInboundRtpStreamStats
      if (stat.type === 'inbound-rtp' && inboundRtpStat.kind === 'video') {
        currentBytes = inboundRtpStat.bytesReceived || 0
      }
    })

    // 断流判定：连接正常但字节数无变化（连续多次）
    if (currentBytes === this.lastBytesReceived) {
      this.consecutiveNoProgress++
      if (this.consecutiveNoProgress >= this.maxNoProgress) {
        this.options.emitter.emit('error', new WebRTCError(ErrorTypes.CONNECT_ERROR, 'data stream interruption'))
        this.consecutiveNoProgress = 0
        return
      }
    }
    else {
      this.consecutiveNoProgress = 0
    }

    // 更新上一次字节数
    this.lastBytesReceived = currentBytes
  }
}
