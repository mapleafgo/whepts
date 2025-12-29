/**
 * 可见性监测（确保回调执行完成后再处理后续，不丢弃任务）
 */
export default class VisibilityObserver {
  private observer?: IntersectionObserver

  start(element: HTMLElement, callback: (isIntersecting: boolean) => void) {
    if (!element)
      return

    // 先停止之前的任务
    this.stop()

    this.observer = new IntersectionObserver(
      ([entry]) => callback(entry.isIntersecting),
      { threshold: 0.5 },
    )

    this.observer.observe(element)
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = undefined
    }
  }
}
