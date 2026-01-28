import type { EventEmitter } from 'eventemitter3'
import type { MonitorScheduler } from './scheduler'
import { TaskPriority } from './scheduler'

/**
 * PlayMonitor 配置选项
 */
export interface PlayMonitorOptions {
  /** 媒体容器元素 */
  container: HTMLMediaElement
  /** 事件发射器 */
  emitter: EventEmitter
}

/**
 * 播放监控器
 *
 * 处理媒体元素播放逻辑，包括自动播放、错误处理、
 * 播放验证和停滞检测。
 *
 * 使用调度器进行定时检查，与其他监控器共享计时器资源。
 */
export class PlayMonitor {
  private lastCurrentTime = 0
  private unregisterMonitor?: () => void
  private readonly scheduler: MonitorScheduler

  constructor(
    private options: PlayMonitorOptions,
    scheduler: MonitorScheduler,
  ) {
    this.scheduler = scheduler
  }

  /**
   * 获取媒体容器
   */
  private get container(): HTMLMediaElement {
    return this.options.container
  }

  /**
   * 获取事件发射器
   */
  private get emitter(): EventEmitter {
    return this.options.emitter
  }

  /**
   * 尝试播放媒体
   */
  async play(): Promise<void> {
    // 如果已经在播放，跳过播放但仍需启动监控
    if (!this.container.paused) {
      this.startMonitoring()
      return
    }

    try {
      await this.container.play()

      // 触发成功事件
      this.emitter.emit('play:success', {
        muted: this.container.muted,
      })

      // 延迟验证播放状态
      setTimeout(() => this.verifyPlayback(), 500)

      // 启动停滞监控
      this.startMonitoring()
    }
    catch (error) {
      // 如果未静音，尝试静音后重试
      if (!this.container.muted) {
        this.container.muted = true
        try {
          await this.container.play()

          this.emitter.emit('play:success', {
            muted: true,
          })

          // 延迟验证播放状态
          setTimeout(() => this.verifyPlayback(), 500)

          // 启动停滞监控
          this.startMonitoring()
          return
        }
        catch {
          // 静音重试也失败，继续处理错误
        }
      }

      // 完全失败
      this.emitter.emit('play:failed', {
        reason: error instanceof Error ? error.message : 'Autoplay failed',
        muted: this.container.muted,
      })
    }
  }

  /**
   * 验证 play() 调用后播放是否真正开始。
   */
  private verifyPlayback(): void {
    // 检查视频是否真正在播放
    if (this.container.paused) {
      this.emitter.emit('play:stalled', {
        reason: 'Playback verification failed: media is paused',
      })
      return
    }

    // 检查 currentTime 是否在前进
    if (this.container.currentTime === 0) {
      this.emitter.emit('play:stalled', {
        reason: 'Playback verification failed: currentTime is not advancing',
      })
    }
  }

  /**
   * 启动播放停滞监控
   */
  private startMonitoring(): void {
    // 先停止已有的监控
    this.stopMonitoring()

    // 初始化 lastCurrentTime
    this.lastCurrentTime = this.container.currentTime

    // 注册监控任务（使用固定的类型名称作为 owner）
    this.unregisterMonitor = this.scheduler.register({
      interval: 5000,
      owner: 'play-monitor', // 固定的类型名称
      priority: TaskPriority.NORMAL,
      callback: () => this.checkStalled(),
    })
  }

  /**
   * 停止播放停滞监控
   */
  stopMonitoring(): void {
    if (this.unregisterMonitor) {
      this.unregisterMonitor()
      this.unregisterMonitor = undefined
    }
  }

  /**
   * 检查播放是否停滞
   */
  private checkStalled(): void {
    const currentTime = this.container.currentTime
    const timeAdvanced = currentTime - this.lastCurrentTime

    // 如果 5 秒内时间前进少于 0.1 秒，认为已停滞
    if (timeAdvanced < 0.1 && !this.container.paused) {
      this.emitter.emit('play:stalled', {
        reason: `Playback stalled: currentTime not advancing (advanced ${timeAdvanced.toFixed(2)}s in 5s)`,
      })
    }

    this.lastCurrentTime = currentTime
  }
}
