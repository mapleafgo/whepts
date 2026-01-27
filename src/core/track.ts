import { atom } from 'nanostores'

export class TrackManager {
  private stream?: MediaStream
  private observer?: IntersectionObserver
  private showStore = atom<boolean>(false)

  constructor(private container: HTMLMediaElement, private lazyLoad: boolean = true) {
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

  onTrack(evt: RTCTrackEvent): void {
    this.stream = evt.streams[0]
    if (this.showStore.value)
      this.container.srcObject = this.stream
  }

  get paused(): boolean {
    return this.container.srcObject === null
  }

  pause(): void {
    this.container.srcObject = null
  }

  resume(): void {
    if (this.stream)
      this.container.srcObject = this.stream
  }

  stop(): void {
    this.stream = undefined
  }
}
