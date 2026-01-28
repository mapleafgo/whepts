import type EventEmitter from 'eventemitter3'
import type { MonitorScheduler } from './scheduler'
import { TaskPriority } from './scheduler'

/**
 * FlowMonitor 配置选项
 */
export interface FlowMonitorOptions {
  /** 基础检查间隔（毫秒），初始阶段使用 */
  interval: number
  /** 稳定后的检查间隔（毫秒），默认为 interval 的 2 倍 */
  stableInterval?: number
  /** 连续无进度的最大次数，超过则判定为断流，默认为 3 */
  maxNoProgress?: number
  /** 稳定时间（毫秒），超过此时间后降低检查频率，默认为 30000（30秒） */
  stabilizationTime?: number
  /** 事件发射器 */
  emitter: EventEmitter
}

/**
 * 流量监控器
 *
 * 监控 WebRTC 视频流的数据传输状态，通过检测视频接收字节数是否增长来判定是否断流。
 *
 * 性能优化特性：
 * - 自适应轮询：初始阶段高频检查，稳定后降低频率
 * - 容错机制：连续多次无进度才判定断流，避免误判
 * - 持续监控：即使视频不可见，也保持监控以确保连接健康
 * - 专注视频：只监控视频流，不监控音频流
 */
export class FlowMonitor {
  private readonly baseInterval: number
  private readonly stableInterval: number
  private readonly maxNoProgress: number
  private readonly stabilizationTime: number
  private readonly scheduler: MonitorScheduler

  private lastBytesReceived: number = 0
  private isFirstCheck: boolean = true
  private unregisterMonitor?: () => void
  private pc?: RTCPeerConnection

  // 状态跟踪
  private consecutiveNoProgress: number = 0
  private startTime: number = 0

  constructor(
    private options: FlowMonitorOptions,
    scheduler: MonitorScheduler,
  ) {
    this.scheduler = scheduler
    this.baseInterval = options.interval
    this.stableInterval = options.stableInterval || (options.interval * 2)
    this.maxNoProgress = options.maxNoProgress || 3
    this.stabilizationTime = options.stabilizationTime || 30000 // 30秒
  }

  /**
   * 启动断流检测
   */
  start(pc?: RTCPeerConnection): void {
    if (!pc) {
      return
    }
    this.pc = pc
    this.reset()
    this.startTime = Date.now()
    this.scheduleCheck()
  }

  /**
   * 停止断流检测并清理资源
   */
  stop(): void {
    if (this.unregisterMonitor) {
      this.unregisterMonitor()
      this.unregisterMonitor = undefined
    }
    this.pc = undefined
  }

  /**
   * 重置检测状态
   */
  reset(): void {
    this.consecutiveNoProgress = 0
    this.isFirstCheck = true
    this.lastBytesReceived = 0
  }

  /**
   * 调度检查任务
   */
  private scheduleCheck(): void {
    // 取消旧任务
    if (this.unregisterMonitor) {
      this.unregisterMonitor()
    }

    const interval = this.getNextCheckInterval()

    // 注册新任务（使用固定的类型名称作为 owner）
    this.unregisterMonitor = this.scheduler.register({
      interval,
      owner: 'flow-monitor', // 固定的类型名称
      priority: TaskPriority.HIGH,
      callback: () => this.performCheck(),
    })
  }

  /**
   * 执行流状态检查
   */
  private performCheck(): void {
    if (!this.shouldCheck()) {
      return
    }

    this.checkFlowState().catch(() => {
      // 忽略 getStats 错误，继续下次检查
    })

    // 重新调度（检查间隔可能变化）
    if (this.shouldContinueMonitoring()) {
      this.scheduleCheck()
    }
  }

  /**
   * 判断是否应该继续监控
   */
  private shouldContinueMonitoring(): boolean {
    return !!(this.pc && this.pc.connectionState === 'connected')
  }

  /**
   * 判断是否应该进行检查
   */
  private shouldCheck(): boolean {
    return !!(this.pc && this.pc.connectionState === 'connected')
  }

  /**
   * 计算下次检查间隔
   */
  private getNextCheckInterval(): number {
    const elapsedTime = Date.now() - this.startTime
    return elapsedTime > this.stabilizationTime ? this.stableInterval : this.baseInterval
  }

  /**
   * 检测流状态（通过接收字节数判断是否断流）
   */
  private async checkFlowState(): Promise<void> {
    const currentBytes = await this.getReceivedBytes()

    // 首次检查时只记录初始值，不进行断流判定
    if (this.isFirstCheck) {
      this.lastBytesReceived = currentBytes
      this.isFirstCheck = false
      return
    }

    // 检测是否有数据增长
    if (this.hasDataProgress(currentBytes)) {
      this.consecutiveNoProgress = 0
    }
    else {
      this.handleNoProgress()
    }

    // 更新上一次字节数
    this.lastBytesReceived = currentBytes
  }

  /**
   * 获取当前已接收的视频字节数
   *
   * 作为视频播放器，只监控视频流的数据传输状态。
   */
  private async getReceivedBytes(): Promise<number> {
    if (!this.pc) {
      return 0
    }

    try {
      const stats = await this.pc.getStats()
      let videoBytes = 0

      stats.forEach((stat) => {
        if (stat.type === 'inbound-rtp') {
          const inboundRtp = stat as RTCInboundRtpStreamStats
          // 只监控视频流
          if (inboundRtp.kind === 'video' && inboundRtp.bytesReceived !== undefined) {
            videoBytes = inboundRtp.bytesReceived
          }
        }
      })

      return videoBytes
    }
    catch {
      return 0
    }
  }

  /**
   * 判断是否有数据增长
   */
  private hasDataProgress(currentBytes: number): boolean {
    return currentBytes > this.lastBytesReceived
  }

  /**
   * 处理无进度情况
   */
  private handleNoProgress(): void {
    this.consecutiveNoProgress++

    if (this.consecutiveNoProgress >= this.maxNoProgress) {
      this.triggerStreamError()
      this.consecutiveNoProgress = 0
    }
  }

  /**
   * 触发断流停滞事件
   */
  private triggerStreamError(): void {
    this.options.emitter.emit('flow:stalled', {
      reason: 'Stream interrupted: video flow stalled',
    })
  }
}
