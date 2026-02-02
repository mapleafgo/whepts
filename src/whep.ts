import type { Conf, State, WhepEvents } from './types'
import EventEmitter from 'eventemitter3'
import { atom } from 'nanostores'
import { CodecDetector } from './core/codec'
import { ConnectionManager } from './core/connection'
import { HttpClient } from './core/http'
import { TrackManager } from './core/track'
import { ErrorTypes, WebRTCError } from './errors'
import { MonitorScheduler } from './monitors/scheduler'

/** WebRTC/WHEP reader. */
export default class WebRTCWhep extends EventEmitter<WhepEvents> {
  private retryPause: number = 2000
  private conf: Conf
  private stateStore = atom<State>('getting_codecs')
  private restartTimeout?: ReturnType<typeof setTimeout>
  private sessionUrl?: string
  private queuedCandidates: RTCIceCandidate[] = []
  private nonAdvertisedCodecs: string[] = []
  private scheduler: MonitorScheduler
  private httpClient: HttpClient
  private connectionManager: ConnectionManager
  private trackManager: TrackManager
  private codecDetector: CodecDetector

  constructor(conf: Conf) {
    super()
    this.conf = conf

    // Listen to state changes and emit events
    this.stateStore.subscribe((current, previous) => {
      console.warn(`State: ${previous} → ${current}`)
      this.emit('state:change', { from: previous as State, to: current })
    })

    // 创建调度器实例
    this.scheduler = new MonitorScheduler()

    this.trackManager = new TrackManager(this.conf.container, this, this.conf.lazyLoad, this.scheduler)

    this.httpClient = new HttpClient({
      conf: this.conf,
      getState: () => this.stateStore.get(),
      emitter: this,
    })

    this.connectionManager = new ConnectionManager({
      getState: () => this.stateStore.get(),
      emitter: this,
      getNonAdvertisedCodecs: () => this.nonAdvertisedCodecs,
    })

    this.codecDetector = new CodecDetector({
      getState: () => this.stateStore.get(),
      emitter: this,
    })

    // Listen to codec detection events
    this.on('codecs:detected', (codecs: string[]) => this.handleCodecsDetected(codecs))

    // Listen to connection events
    this.on('candidate', (candidate: RTCIceCandidate) => this.handleCandidate(candidate))
    this.on('track', (evt: RTCTrackEvent) => this.trackManager.onTrack(evt, this.connectionManager.getPeerConnection()))

    // 监听停滞事件，并尝试恢复
    this.on('play:stalled', payload => this.handlePlayStalled(payload))
    this.on('flow:stalled', payload => this.handleFlowStalled(payload))

    // 监听异常，并尝试处理
    this.on('error', err => this.handleError(err))

    this.codecDetector.detect()
  }

  get state(): State {
    return this.stateStore.get()
  }

  close(): void {
    this.stateStore.set('closed')
    this.connectionManager.close()
    this.trackManager.destroy() // 永久销毁
    this.scheduler.destroy() // 销毁调度器
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
    }
    this.emit('close')
  }

  private cleanupSession(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = undefined
    }

    this.connectionManager.close()
    this.trackManager.stop()
    this.queuedCandidates = []

    if (this.sessionUrl) {
      fetch(this.sessionUrl, {
        method: 'DELETE',
      }).catch(() => { }) // Ignore deletion errors
      this.sessionUrl = undefined
    }
  }

  private handleError(err: Error | WebRTCError): void {
    // 永久性错误：信号、请求、状态错误 → failed
    if (err instanceof WebRTCError) {
      this.cleanupSession()
      this.stateStore.set('failed')
    }
    // 初始化阶段的其他错误 → failed
    else if (this.stateStore.get() === 'getting_codecs') {
      this.cleanupSession()
      this.stateStore.set('failed')
    }
    // 运行时的其他错误 → 尝试重启
    else if (this.stateStore.get() === 'running') {
      // 如果是容器错误，尝试重置容器
      if (err instanceof WebRTCError && err.type === ErrorTypes.VIDEO_ERROR) {
        this.handlePlayStalled({ reason: err.message })
        return
      }

      this.cleanupSession()

      this.stateStore.set('restarting')
      this.emit('restart')

      this.restartTimeout = setTimeout(() => {
        this.restartTimeout = undefined
        this.stateStore.set('running')
        this.start()
      }, this.retryPause)
    }
  }

  /**
   * 处理播放停滞事件
   *
   * 尝试重新播放，如果失败则触发错误
   */
  private handlePlayStalled(payload: { reason: string }): void {
    console.warn('[PlayStalled]', payload.reason)

    this.pause()

    // 对于 MediaStream (srcObject)，不需要 load()，直接恢复即可
    setTimeout(() => this.resume(), 100)
  }

  /**
   * 处理流量停滞事件
   *
   * 清理会话并重新连接，类似于网络错误的处理
   */
  private handleFlowStalled(payload: { reason: string }): void {
    console.warn('[FlowStalled]', payload.reason)

    // 流停滞，清理会话并重新连接
    if (this.stateStore.get() === 'running') {
      this.cleanupSession()

      this.stateStore.set('restarting')
      this.emit('restart')

      this.restartTimeout = setTimeout(() => {
        this.restartTimeout = undefined
        this.stateStore.set('running')
        this.start()
      }, this.retryPause)
    }
  }

  private handleCodecsDetected(codecs: string[]): void {
    this.nonAdvertisedCodecs = codecs
    this.stateStore.set('running')
    this.start()
  }

  private start(): void {
    this.httpClient.requestICEServers()
      .then(iceServers => this.connectionManager.setupPeerConnection(iceServers))
      .then(offer => this.httpClient.sendOffer(offer))
      .then(({ sessionUrl, answer }) => this.handleOfferResponse(sessionUrl, answer))
      .catch(err => this.handleError(err))
  }

  private handleOfferResponse(sessionUrl: string | undefined, answer: string): Promise<void> {
    if (sessionUrl)
      this.sessionUrl = sessionUrl

    return this.connectionManager.setAnswer(answer).then(() => {
      if (this.stateStore.get() !== 'running')
        return

      if (this.queuedCandidates.length !== 0) {
        const offerData = this.connectionManager.getOfferData()
        if (offerData && this.sessionUrl) {
          this.httpClient.sendLocalCandidates(this.sessionUrl, offerData, this.queuedCandidates)
          this.queuedCandidates = []
        }
      }
    })
  }

  private handleCandidate(candidate: RTCIceCandidate): void {
    if (this.sessionUrl) {
      const offerData = this.connectionManager.getOfferData()
      if (offerData) {
        this.httpClient.sendLocalCandidates(this.sessionUrl, offerData, [candidate])
      }
    }
    else {
      this.queuedCandidates.push(candidate)
    }
  }

  get paused(): boolean {
    return this.trackManager.paused
  }

  pause(): void {
    this.trackManager.pause()
  }

  resume(): void {
    this.trackManager.resume()
  }

  /**
   * Update the WHEP endpoint URL and restart playback.
   * Useful when the current URL fails and you need to switch to a new URL.
   *
   * @param url - The new WHEP endpoint URL
   *
   * @example
   * ```ts
   * player.on('error', () => {
   *   // Get new URL from your server
   *   const newUrl = await getNewStreamUrl()
   *   player.updateUrl(newUrl)
   * })
   * ```
   */
  updateUrl(url: string): void {
    // Cannot update URL if already closed
    if (this.state === 'closed') {
      this.emit('error', new WebRTCError(ErrorTypes.STATE_ERROR, 'Cannot update URL: instance is closed'))
      return
    }

    // Update the URL
    this.conf.url = url

    // Cleanup existing session
    this.cleanupSession()

    // Reset to running state and start with new URL
    this.stateStore.set('running')
    this.start()
  }
}
