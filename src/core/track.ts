import type { EventEmitter } from 'eventemitter3'
import type { MonitorScheduler } from '~/monitors/scheduler'
import { atom } from 'nanostores'
import { FlowMonitor } from '~/monitors/flow-monitor'
import { PlayMonitor } from '~/monitors/play-monitor'

export class TrackManager {
  private stream?: MediaStream
  private observer?: IntersectionObserver
  private showStore = atom<boolean>(false)
  private playMonitor: PlayMonitor
  private flowMonitor: FlowMonitor

  constructor(
    private container: HTMLMediaElement,
    eventEmitter: EventEmitter,
    private lazyLoad: boolean = true,
    scheduler: MonitorScheduler,
  ) {
    this.playMonitor = new PlayMonitor(
      {
        container,
        emitter: eventEmitter,
      },
      scheduler,
    )

    // 创建流量监控器，但不在此时启动
    this.flowMonitor = new FlowMonitor(
      {
        interval: 5000,
        emitter: eventEmitter,
      },
      scheduler,
    )

    // 监听显示状态
    this.showStore.subscribe((show) => {
      if (show)
        this.resume()
      else
        this.pause()
    })

    // 创建新的可见性观察器，自动处理暂停/恢复
    if (this.lazyLoad) {
      this.observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting)
            this.showStore.set(true)
          else
            this.showStore.set(false)
        },
        { threshold: 0.5 },
      )

      this.observer.observe(this.container)
    }
    else {
      // 如果不启用懒加载，默认设置为显示状态
      this.showStore.set(true)
    }
  }

  onTrack(evt: RTCTrackEvent, pc?: RTCPeerConnection): void {
    this.stream = evt.streams[0]
    if (this.showStore.get()) {
      this.container.srcObject = this.stream
      this.playMonitor.play()
    }
    // 自动启动流量监控
    this.flowMonitor.start(pc)
  }

  get paused(): boolean {
    return this.container.srcObject === null
  }

  pause(): void {
    // 暂停播放监控
    this.playMonitor.stopMonitoring()
    // 清除媒体源（停止播放）
    this.container.srcObject = null
  }

  resume(): void {
    if (this.stream) {
      this.container.srcObject = this.stream
      this.playMonitor.play()
    }
  }

  stop(): void {
    this.playMonitor.stopMonitoring()
    this.flowMonitor.stop()
    this.stream = undefined

    // 清理观察器
    if (this.observer) {
      this.observer.disconnect()
      this.observer = undefined
    }
  }
}
