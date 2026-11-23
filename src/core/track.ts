import type { MonitorScheduler } from '~/monitors/scheduler'
import type { MediaNotifier } from '~/types'
import { FlowMonitor } from '~/monitors/flow-monitor'
import { PlayMonitor } from '~/monitors/play-monitor'

export class TrackManager {
  private stream?: MediaStream
  private observer?: IntersectionObserver
  private visible: boolean
  private manualPause = false
  private videoDeadline?: ReturnType<typeof setTimeout>
  private waitingForVideo = false
  private readonly watchedVideoTracks = new Set<MediaStreamTrack>()
  private playMonitor: PlayMonitor
  private flowMonitor: FlowMonitor

  constructor(
    private container: HTMLMediaElement,
    private notify: MediaNotifier,
    lazyLoad: boolean,
    scheduler: MonitorScheduler,
    onFlowProgress: (pc: RTCPeerConnection) => void,
    onFlowTimeout: (pc: RTCPeerConnection, elapsedMs: number) => void,
    onFlowSampleFailed: (pc: RTCPeerConnection, errorName: string) => void,
  ) {
    this.playMonitor = new PlayMonitor(
      {
        container,
        notify: this.notify,
      },
      scheduler,
    )

    // 创建流量监控器
    this.flowMonitor = new FlowMonitor(
      {
        onProgress: onFlowProgress,
        onTimeout: onFlowTimeout,
        onSampleFailed: onFlowSampleFailed,
        notify: this.notify,
      },
      scheduler,
    )

    this.visible = !lazyLoad
    if (lazyLoad) {
      const threshold = 0.5
      this.observer = new IntersectionObserver(([entry]) => {
        if (!entry || !this.observer)
          return
        this.visible = entry.isIntersecting && entry.intersectionRatio >= threshold
        this.syncPlayback()
      }, { threshold })
      this.observer.observe(container)
    }
  }

  waitForVideo(timeoutMs: number): void {
    if (this.waitingForVideo)
      return
    this.waitingForVideo = true
    if (this.hasVideo())
      return

    this.videoDeadline = setTimeout(() => {
      this.videoDeadline = undefined
      if (!this.hasVideo())
        this.reportVideoUnavailable('No video track arrived after connecting')
    }, timeoutMs)
  }

  private hasVideo(): boolean {
    return this.stream?.getTracks().some(track => track.kind === 'video' && track.readyState !== 'ended') ?? false
  }

  onTrack(evt: RTCTrackEvent, pc?: RTCPeerConnection): void {
    const incoming = evt.streams[0]
    const previousTracks = this.stream?.getTracks() ?? []
    const tracks = [...new Set([...previousTracks, ...(incoming?.getTracks() ?? []), ...(evt.track ? [evt.track] : [])])].filter(track => track.readyState !== 'ended')
    if (tracks.length !== previousTracks.length || tracks.some(track => !previousTracks.includes(track))) {
      this.playMonitor.stopMonitoring()
      // 不先清空元素：清空再赋值会让元素多跑一次 load algorithm，落在尚未完成的加载上。
      this.stream = !this.stream && incoming ? incoming : new MediaStream(tracks)
    }

    if (evt.track?.kind === 'video' && evt.track.readyState !== 'ended' && !this.watchedVideoTracks.has(evt.track)) {
      this.watchedVideoTracks.add(evt.track)
      evt.track.addEventListener('ended', this.onVideoEnded)
    }

    if (this.hasVideo()) {
      clearTimeout(this.videoDeadline)
      this.videoDeadline = undefined
      this.syncPlayback()
      this.flowMonitor.start(pc)
    }
  }

  private onVideoEnded = (event: Event): void => {
    const track = event.currentTarget as MediaStreamTrack
    if (!this.watchedVideoTracks.delete(track))
      return
    track.removeEventListener('ended', this.onVideoEnded)
    if (this.hasVideo())
      return

    this.playMonitor.stopMonitoring()
    this.flowMonitor.stop()
    this.detachStream()
    this.reportVideoUnavailable('The last video track ended')
  }

  private reportVideoUnavailable(reason: string): void {
    this.notify('play:failed', {
      code: 'video-unavailable',
      reason,
      muted: this.container.muted,
    })
  }

  get paused(): boolean {
    return this.container.srcObject === null
  }

  pause(): void {
    this.manualPause = true
    this.syncPlayback()
  }

  resume(): void {
    this.manualPause = false
    this.syncPlayback()
  }

  private syncPlayback(): void {
    if (!this.visible || this.manualPause) {
      // 与 stop() 保持一致：卸载时同时停止采样并作废旧恢复。
      this.playMonitor.stopMonitoring()
      this.playMonitor.invalidate()
      this.detachStream()
      return
    }

    // 宿主可能带外改写 srcObject；调用方主动驱动时以自家 stream 为唯一真值重新接管。
    if (!this.stream || !this.hasVideo())
      return

    const attached = this.container.srcObject !== this.stream
    if (attached)
      this.container.srcObject = this.stream
    void this.playMonitor.play({ freshStream: attached })
  }

  /** Cancel media recovery that belongs to a transport that no longer exists. */
  invalidateMediaRecovery(): void {
    this.playMonitor.invalidate()
  }

  stop(): void {
    for (const track of this.watchedVideoTracks)
      track.removeEventListener('ended', this.onVideoEnded)
    this.watchedVideoTracks.clear()
    clearTimeout(this.videoDeadline)
    this.videoDeadline = undefined
    this.waitingForVideo = false
    this.playMonitor.stopMonitoring()
    this.playMonitor.invalidate()
    this.flowMonitor.stop()
    this.detachStream()
    this.stream = undefined
  }

  private detachStream(): void {
    if (this.stream && this.container.srcObject === this.stream)
      this.container.srcObject = null
  }

  /**
   * 永久销毁（仅在 WebRTCWhep.close() 时调用）
   */
  destroy(): void {
    this.stop()
    this.playMonitor.destroy()

    // 清理观察器
    if (this.observer) {
      this.observer.disconnect()
      this.observer = undefined
    }
  }
}
