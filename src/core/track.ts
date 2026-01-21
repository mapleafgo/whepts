export class TrackManager {
  private stream?: MediaStream
  private observer?: IntersectionObserver

  constructor(private container: HTMLMediaElement) {}

  onTrack(evt: RTCTrackEvent): void {
    this.stream = evt.streams[0]

    // 停止之前的观察器
    this.stopObserver()

    // 创建新的可见性观察器，自动处理暂停/恢复
    this.observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting)
          this.resume()
        else
          this.pause()
      },
      { threshold: 0.5 },
    )

    this.observer.observe(this.container)
  }

  private stopObserver(): void {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = undefined
    }
  }

  get paused(): boolean {
    return this.container.srcObject === null
  }

  pause(): void {
    this.container.srcObject = null
  }

  resume(): void {
    if (this.stream && this.paused)
      this.container.srcObject = this.stream
  }

  stop(): void {
    this.stopObserver()
    this.stream = undefined
  }
}
