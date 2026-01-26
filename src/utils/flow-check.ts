import { ErrorTypes, WebRTCError } from '~/errors'

export interface FlowCheckParams {
  interval: number
  onError: (err: WebRTCError) => void
}

/**
 * Flow checking logic (断流检测)
 */
export class FlowCheck {
  private checkInterval: number
  private lastBytesReceived: number = 0
  private checkTimer?: NodeJS.Timeout
  private pc?: RTCPeerConnection
  private onError: (err: WebRTCError) => void

  constructor(params: FlowCheckParams) {
    this.checkInterval = params.interval
    this.onError = params.onError
  }

  setPeerConnection(pc: RTCPeerConnection): void {
    this.pc = pc
  }

  /**
   * 启动断流检测
   */
  start(): void {
    this.stop()
    this.checkTimer = setInterval(() => this.checkFlowState(), this.checkInterval)
  }

  /**
   * 停止断流检测
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = undefined
    }
  }

  /**
   * 检测流状态（通过接收字节数判断是否断流）
   */
  private async checkFlowState(): Promise<void> {
    if (!this.pc) {
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

    // 断流判定：连接正常但字节数无变化
    if (currentBytes === this.lastBytesReceived && this.pc.connectionState === 'connected') {
      this.onError(new WebRTCError(ErrorTypes.CONNECT_ERROR, 'data stream interruption'))
      return
    }

    // 更新上一次字节数
    this.lastBytesReceived = currentBytes
  }
}
