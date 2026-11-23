import type { WhepSession } from './core/http.js'
import type { ErrorPhase } from './errors.js'
import type { Conf, State, WhepDiagnostic, WhepEvents } from './types.js'
import type { ParsedOffer } from './utils/sdp.js'
import { EventEmitter } from 'eventemitter3'
import { atom } from 'nanostores'
import { CodecDetector } from './core/codec.js'
import { ConnectionManager } from './core/connection.js'
import { HttpClient } from './core/http.js'
import { TrackManager } from './core/track.js'
import { ErrorTypes, WebRTCError } from './errors.js'
import { MonitorScheduler } from './monitors/scheduler.js'

// 涵盖信令和首次传输连通，不限制已建立的会话。
const CONNECTION_TIMEOUT_MS = 15000
const CODEC_PROBE_TIMEOUT_MS = 3000
// 传输连通后给远端留出独立的视频轨道到达窗口。
const VIDEO_TRACK_WAIT_MS = 5000
const DISCONNECT_GRACE_MS = 5000
const SESSION_DELETE_TIMEOUT_MS = 5000
// 候选 PATCH 挂起不应拖住后续候选；超时只丢弃该批，会话继续。
const CANDIDATE_PATCH_TIMEOUT_MS = 5000
const RECONNECT_DELAYS_MS = [2000, 4000, 8000] as const

let nextPlayerId = 0

/** Keep only a stable error kind; raw messages may contain server internals. */
function sanitizeCause(error: unknown): string | undefined {
  if (error instanceof WebRTCError) return undefined
  const name = error instanceof Error ? error.name : undefined
  return name === undefined || name === 'Error' ? undefined : name
}

/** Distinguish our own cleanup deadline from any other abort cause. */
function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'TimeoutError'
}

function validateEndpoint(url: string): string {
  const endpoint = URL.canParse(url) ? new URL(url) : undefined
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new WebRTCError(
      ErrorTypes.REQUEST_ERROR,
      'Expected an absolute HTTP or HTTPS WHEP URL without embedded credentials',
      { phase: 'configuration' },
    )

  return endpoint.href
}

/** WebRTC/WHEP reader. */
export default class WebRTCWhep extends EventEmitter<WhepEvents> {
  private reconnectCount = 0
  private conf: Conf & Required<Pick<Conf, 'iceMode' | 'lazyLoad'>>
  private stateStore = atom<State>('getting_codecs')
  private restartTimeout?: ReturnType<typeof setTimeout>
  // undefined 等待响应头；null 表示服务端未提供可用会话地址。
  private session?: WhepSession | null
  private readonly playerId = ++nextPlayerId
  private nextAttemptId = 0
  private attempt?: { id: number; controller: AbortController }
  private connectionDeadline?: ReturnType<typeof setTimeout>
  private answerApplied = false
  private candidateDrain?: AbortSignal
  private queuedCandidates: RTCIceCandidate[] = []
  private nonAdvertisedCodecs: string[] = []
  private scheduler: MonitorScheduler
  private httpClient: HttpClient
  private connectionManager: ConnectionManager
  private trackManager: TrackManager
  private codecDetector: CodecDetector

  /** Create a player; throws a configuration error before startup for an invalid endpoint. */
  constructor(conf: Conf) {
    super()
    if (typeof URL.canParse !== 'function' || typeof AbortSignal.timeout !== 'function')
      throw new WebRTCError(
        ErrorTypes.REQUEST_ERROR,
        'Required browser APIs are unavailable; update to the latest stable browser',
        { phase: 'configuration' },
      )
    const iceMode = conf.iceMode === undefined ? 'trickle' : conf.iceMode
    if (iceMode !== 'trickle' && iceMode !== 'complete')
      throw new WebRTCError(ErrorTypes.REQUEST_ERROR, 'Invalid ICE mode', { phase: 'configuration' })
    this.conf = {
      ...conf,
      iceMode,
      lazyLoad: conf.lazyLoad ?? true,
      url: validateEndpoint(conf.url),
      iceServers: conf.iceServers?.map((server) => ({
        ...server,
        urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
      })),
    }

    // 创建调度器实例
    this.scheduler = new MonitorScheduler()

    this.trackManager = new TrackManager(
      this.conf.container,
      (event, ...args) => this.notify(event, ...args),
      this.conf.lazyLoad,
      this.scheduler,
      (pc) => {
        if (this.attempt && this.state === 'running' && this.connectionManager.getPeerConnection() === pc)
          this.reconnectCount = 0
      },
      (pc, elapsedMs) => {
        const attempt = this.attempt
        if (attempt && this.state === 'running' && this.connectionManager.getPeerConnection() === pc)
          this.notifyDiagnostic(
            { operation: 'sample-flow', phase: 'connection', elapsedMs, reason: 'timeout' },
            attempt.id,
          )
      },
      (pc, errorName) => {
        const attempt = this.attempt
        if (attempt && this.state === 'running' && this.connectionManager.getPeerConnection() === pc)
          this.notifyDiagnostic(
            { operation: 'sample-flow', phase: 'connection', reason: 'request-failed', cause: errorName },
            attempt.id,
          )
      },
    )

    this.httpClient = new HttpClient({
      conf: this.conf,
      getState: () => this.stateStore.get(),
    })

    this.connectionManager = new ConnectionManager({
      getState: () => this.stateStore.get(),
      onCandidate: (candidate) => {
        this.handleCandidate(candidate)
        this.notify('candidate', candidate)
      },
      onTrack: (event, pc) => {
        this.trackManager.onTrack(event, pc)
        if (this.connectionManager.getPeerConnection() === pc) this.notify('track', event)
      },
      getNonAdvertisedCodecs: () => this.nonAdvertisedCodecs,
      // 给浏览器留出自行恢复短暂网络切换的时间。
      disconnectGraceMs: DISCONNECT_GRACE_MS,
      onConnected: () => {
        this.clearConnectionDeadline()
        if (this.state === 'running') this.trackManager.waitForVideo(VIDEO_TRACK_WAIT_MS)
      },
      onTransportFailure: (connected) => {
        if (connected) this.handleTransportFailure()
        else
          this.failSetup(
            'connection',
            new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Peer connection failed before connecting'),
          )
      },
    })

    this.codecDetector = new CodecDetector(CODEC_PROBE_TIMEOUT_MS)

    this.codecDetector
      .detect()
      .then((codecs) => this.handleCodecsDetected(codecs))
      .catch((error: unknown) => {
        // 探测失败不阻断播放：按未检测到扩展编解码器继续。
        // 探测失败是预期内的降级，不是故障：只在调试构建以 debug 级别提示。
        console.debug('[WhepTS] Codec detection failed', {
          playerId: this.playerId,
          error: error instanceof Error ? error.name : 'unknown',
        })
        this.handleCodecsDetected([])
      })
  }

  get state(): State {
    return this.stateStore.get()
  }

  /** Close permanently and detach playback immediately. Remote cleanup continues independently. */
  close(): void {
    if (this.state === 'closed') return

    const from = this.state
    this.stateStore.set('closed')
    this.codecDetector.stop()
    try {
      this.cleanupSession()
    } finally {
      // 本地清理失败也不能让终态通知缺失。
      try {
        this.trackManager.destroy()
        this.scheduler.destroy()
      } finally {
        this.notifyStateChange(from, 'closed')
        this.notify('close')
      }
    }
  }

  private transition(to: State): void {
    const from = this.state
    if (from === to || from === 'closed') return

    this.stateStore.set(to)
    this.notifyStateChange(from, to)
  }

  private notifyStateChange(from: State, to: State): void {
    console.debug('[WhepTS] State changed', { playerId: this.playerId, attemptId: this.attempt?.id, from, to })
    this.notify('state:change', { from, to })
  }

  private cleanupSession(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = undefined
    }

    this.clearConnectionDeadline()
    const attempt = this.attempt
    this.attempt = undefined
    attempt?.controller.abort()
    const session = this.session
    this.session = undefined
    const peer = this.connectionManager.detachPeer()
    if (session) this.deleteSession(session, attempt?.id, peer)
    else peer?.close()
    this.trackManager.stop()
    this.answerApplied = false
    this.candidateDrain = undefined
    this.queuedCandidates = []
  }

  private deleteSession(session: WhepSession, attemptId?: number, peer?: RTCPeerConnection): void {
    // 清理请求不能继承已取消的连接信号。
    const signal = AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS)
    // 让 DELETE 有机会先于服务端的传输断开回收完成。
    const closePeer = (): void => {
      signal.removeEventListener('abort', closePeer)
      peer?.close()
      peer = undefined
    }
    signal.addEventListener('abort', closePeer, { once: true })
    const startedAt = performance.now()
    void this.httpClient
      .deleteSession(session, signal)
      .catch((error: unknown) => {
        const httpStatus = error instanceof WebRTCError ? error.httpStatus : undefined
        this.notifyDiagnostic(
          {
            operation: 'delete-session',
            phase: 'signaling',
            elapsedMs: performance.now() - startedAt,
            reason:
              httpStatus !== undefined ? 'http-error' : isTimeoutReason(signal.reason) ? 'timeout' : 'request-failed',
            ...(httpStatus !== undefined ? { httpStatus } : {}),
          },
          attemptId,
        )
      })
      .finally(closePeer)
  }

  private notifyDiagnostic(
    details: Omit<WhepDiagnostic, 'playerId' | 'attemptId' | 'state'>,
    attemptId?: number,
  ): void {
    try {
      const diagnostic: WhepDiagnostic = {
        playerId: this.playerId,
        ...(attemptId === undefined ? {} : { attemptId }),
        state: this.state,
        ...details,
      }
      console.warn('[WhepTS] Operation failed', diagnostic)
      this.conf.onDiagnostic?.(diagnostic)
    } catch {
      // 诊断回调不得干扰监控或清理。
    }
  }

  private handleTransportFailure(): void {
    // 传输已失效：不留下仍能向元素报告成功的旧恢复流程。
    this.trackManager.invalidateMediaRecovery()
    if (this.state !== 'running') return

    const delay = RECONNECT_DELAYS_MS[this.reconnectCount]
    if (delay === undefined) {
      this.failSetup('connection', new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Reconnect budget exhausted'))
      return
    }

    this.reconnectCount++
    this.cleanupSession()
    const timer = setTimeout(() => {
      if (this.restartTimeout !== timer || this.state !== 'restarting') return
      this.restartTimeout = undefined
      this.transition('running')
      this.start()
    }, delay)
    this.restartTimeout = timer
    this.transition('restarting')
    if (this.restartTimeout !== timer) return

    this.notifyError(new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Peer connection was lost', { phase: 'connection' }))
    if (this.restartTimeout === timer) this.notify('restart')
  }

  private handleCodecsDetected(codecs: string[]): void {
    if (this.state !== 'getting_codecs') return

    this.nonAdvertisedCodecs = codecs
    this.notify('codecs:detected', codecs)
    this.transition('running')
    this.start()
  }

  private start(): void {
    if (this.state !== 'running' || this.attempt) return

    const attempt = { id: ++this.nextAttemptId, controller: new AbortController() }
    this.attempt = attempt
    const progress = { phase: 'signaling' as ErrorPhase }
    this.connectionDeadline = setTimeout(() => {
      if (this.attempt === attempt) this.failSetup(progress.phase, undefined, 'setup-timeout')
    }, CONNECTION_TIMEOUT_MS)
    void this.connect(attempt, progress)
  }

  private clearConnectionDeadline(): void {
    clearTimeout(this.connectionDeadline)
    this.connectionDeadline = undefined
  }

  private async connect(attempt: NonNullable<WebRTCWhep['attempt']>, progress: { phase: ErrorPhase }): Promise<void> {
    const { signal } = attempt.controller
    try {
      const iceServers = await this.httpClient.requestICEServers(signal)
      signal.throwIfAborted()
      progress.phase = 'connection'
      const offer = await this.connectionManager.setupPeerConnection(
        iceServers,
        signal,
        this.conf.iceMode === 'complete',
      )
      signal.throwIfAborted()
      progress.phase = 'signaling'
      const result = await this.httpClient.sendOffer(offer, signal, (session) => {
        if (signal.aborted) {
          if (session) this.deleteSession(session, attempt.id)
          return
        }
        this.session = session
        if (!session) this.queuedCandidates = []
      })
      signal.throwIfAborted()
      progress.phase = 'connection'
      if ('counterOffer' in result) {
        await this.answerCounterOffer(result, signal)
        return
      }
      await this.handleOfferResponse(result.answer, signal)
    } catch (error) {
      if (!signal.aborted) this.failSetup(progress.phase, error)
    }
  }

  private failSetup(phase: ErrorPhase, error: unknown, reason?: WebRTCError['reason']): void {
    this.cleanupSession()
    this.transition('failed')
    if (this.state !== 'failed') return

    const type = error instanceof WebRTCError ? error.type : ErrorTypes.OTHER_ERROR
    const message =
      reason === 'setup-timeout'
        ? 'WHEP connection attempt timed out'
        : phase === 'signaling'
          ? 'WHEP signaling failed'
          : 'Peer connection failed'
    const httpStatus = error instanceof WebRTCError ? error.httpStatus : undefined
    const cause = sanitizeCause(error)
    this.notifyError(
      new WebRTCError(type, message, { phase, httpStatus, reason, ...(cause === undefined ? {} : { cause }) }),
    )
  }

  /**
   * Dispatch one public event. Listeners are registered through `on`/`once` wrappers that
   * catch host exceptions, so a failing listener neither stops the others nor fails playback.
   */
  private notify<K extends keyof WhepEvents>(event: K, ...args: EventEmitter.EventArgs<WhepEvents, K>): void {
    this.emit(event, ...args)
  }

  private reportListenerFailure(event: string, error: unknown): void {
    const cause = error instanceof Error ? error.name : 'unknown'
    this.notifyDiagnostic({ operation: 'listener-error', reason: 'request-failed', cause })
    // 监听器异常属于调用方 bug，通过诊断通道对外，日志只作调试提示。
    console.debug('[WhepTS] Public event listener failed', { playerId: this.playerId, event, cause })
  }

  /** Wrappers indexed per listener and context so each registration can be removed alone. */
  private guardedListeners = new WeakMap<object, Map<unknown, (...values: unknown[]) => unknown>>()

  private guardListener<K extends keyof WhepEvents>(
    event: K,
    listener: EventEmitter.EventListener<WhepEvents, K>,
    context?: unknown,
  ): EventEmitter.EventListener<WhepEvents, K> {
    const target = context ?? this
    const guarded = (...args: Parameters<EventEmitter.EventListener<WhepEvents, K>>): void => {
      try {
        // 与 emitter 一致：未指定 context 时以播放器为 this。
        Reflect.apply(listener as (...values: unknown[]) => unknown, target, args)
      } catch (error) {
        this.reportListenerFailure(String(event), error)
      }
    }
    const wrapper = guarded as EventEmitter.EventListener<WhepEvents, K>
    const key = listener as object
    const byContext = this.guardedListeners.get(key) ?? new Map<unknown, (...values: unknown[]) => unknown>()
    // 同一引用同一 context 只保留一个包装，避免旧包装失去簿记后无法移除。
    const previous = byContext.get(context)
    if (previous !== undefined)
      super.removeListener(event, previous as EventEmitter.EventListener<WhepEvents, K>, context)
    byContext.set(context, guarded as (...values: unknown[]) => unknown)
    this.guardedListeners.set(key, byContext)
    return wrapper
  }

  private unwrapListener<K extends keyof WhepEvents>(
    listener: EventEmitter.EventListener<WhepEvents, K>,
    context?: unknown,
  ): EventEmitter.EventListener<WhepEvents, K> {
    return (this.guardedListeners.get(listener as object)?.get(context) ?? listener) as EventEmitter.EventListener<
      WhepEvents,
      K
    >
  }

  /** Remove listeners through their original reference, not the internal wrapper. */
  override off<K extends keyof WhepEvents>(
    event: K,
    listener: EventEmitter.EventListener<WhepEvents, K>,
    context?: unknown,
    once?: boolean,
  ): this {
    return super.off(event, this.unwrapListener(listener, context), context, once) as this
  }

  override removeListener<K extends keyof WhepEvents>(
    event: K,
    listener: EventEmitter.EventListener<WhepEvents, K>,
    context?: unknown,
    once?: boolean,
  ): this {
    return super.removeListener(event, this.unwrapListener(listener, context), context, once) as this
  }

  /** Register a guarded listener; `context` stays optional like the emitter's own API. */
  override on<K extends keyof WhepEvents>(
    event: K,
    listener: EventEmitter.EventListener<WhepEvents, K>,
    context?: unknown,
  ): this {
    return super.on(event, this.guardListener(event, listener, context), context) as this
  }

  /** `addListener` is an alias of `on`; guard it too so every registered listener is isolated. */
  override addListener<K extends keyof WhepEvents>(
    event: K,
    listener: EventEmitter.EventListener<WhepEvents, K>,
    context?: unknown,
  ): this {
    return this.on(event, listener, context)
  }

  /** `once` keeps the emitter's removal semantics because the wrapper itself is removed. */
  override once<K extends keyof WhepEvents>(
    event: K,
    listener: EventEmitter.EventListener<WhepEvents, K>,
    context?: unknown,
  ): this {
    return super.once(event, this.guardListener(event, listener, context), context) as this
  }

  private notifyError(error: WebRTCError): void {
    console.warn('[WhepTS] Player error', {
      playerId: this.playerId,
      state: this.state,
      type: error.type,
      phase: error.phase,
      reason: error.reason,
      httpStatus: error.httpStatus,
    })
    this.notify('error', error)
  }

  private async answerCounterOffer(
    offer: { counterOffer: string; expiresAt: number },
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.session
    // 反向 offer 只有在 Location 可用时才能提交应答。
    if (!session)
      throw new WebRTCError(ErrorTypes.REQUEST_ERROR, 'Counter-offer without a session URL', {
        phase: 'signaling',
        httpStatus: 406,
      })
    // 超出有效期的反向 offer 不再应答。
    if (Date.now() > offer.expiresAt)
      throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Counter-offer expired before answering', { phase: 'signaling' })
    const answer = await this.connectionManager.answerCounterOffer(offer.counterOffer, signal)
    signal.throwIfAborted()
    this.answerApplied = true
    await this.httpClient.sendAnswer(session, answer, signal)
    signal.throwIfAborted()
    if (this.session === session) void this.flushCandidates(signal)
  }

  private handleOfferResponse(answer: string, signal: AbortSignal): Promise<void> {
    return this.connectionManager.setAnswer(answer).then(() => {
      signal.throwIfAborted()
      this.answerApplied = true
      void this.flushCandidates(signal)
    })
  }

  private handleCandidate(candidate: RTCIceCandidate): void {
    const signal = this.attempt?.controller.signal
    if (this.conf.iceMode === 'complete' || !signal || signal.aborted || this.session === null) return

    this.queuedCandidates.push(candidate)
    void this.flushCandidates(signal)
  }

  private async flushCandidates(signal: AbortSignal): Promise<void> {
    if (
      this.state !== 'running' ||
      !this.answerApplied ||
      this.candidateDrain === signal ||
      !this.session ||
      this.queuedCandidates.length === 0
    )
      return

    const offer = this.connectionManager.getOfferData()
    if (!offer) return

    const session = this.session
    // 归属在发起时确定：失败回调时 this.attempt 可能已换成新尝试。
    const attemptId = this.attempt?.id
    this.candidateDrain = signal
    try {
      while (!signal.aborted && this.queuedCandidates.length !== 0) {
        const batch = this.queuedCandidates
        this.queuedCandidates = []
        if (!(await this.sendCandidateBatch(session, offer, batch, signal, attemptId))) return
      }
    } finally {
      if (this.candidateDrain === signal) this.candidateDrain = undefined
    }
  }

  /**
   * Send one candidate batch with its own deadline.
   * Returns false only when the attempt was aborted; other failures are reported and dropped.
   */
  private async sendCandidateBatch(
    session: WhepSession,
    offer: ParsedOffer,
    batch: RTCIceCandidate[],
    signal: AbortSignal,
    attemptId?: number,
  ): Promise<boolean> {
    const startedAt = performance.now()
    const deadline = new AbortController()
    const batchSignal = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(
      () => deadline.abort(new DOMException('Candidate PATCH timed out', 'TimeoutError')),
      CANDIDATE_PATCH_TIMEOUT_MS,
    )
    try {
      const rotatedTag = await this.httpClient.sendLocalCandidates(session, offer, batch, batchSignal)
      if (rotatedTag !== null && this.session === session) session.etag = rotatedTag
      return true
    } catch (error) {
      // 连接已取消时静默退出；其他失败只丢该批并记录诊断。
      if (signal.aborted) return false
      this.notifyDiagnostic(
        {
          operation: 'trickle-ice',
          phase: 'signaling',
          elapsedMs: performance.now() - startedAt,
          reason: deadline.signal.aborted ? 'timeout' : 'request-failed',
          ...(error instanceof WebRTCError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
        },
        attemptId,
      )
      return true
    } finally {
      clearTimeout(timer)
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
   * player.updateUrl('https://media.example.com/backup/whep')
   * ```
   */
  updateUrl(url: string): void {
    // Cannot update URL if already closed
    if (this.state === 'closed') {
      this.notifyError(new WebRTCError(ErrorTypes.STATE_ERROR, 'Cannot update URL: instance is closed'))
      return
    }

    let endpoint: string
    try {
      endpoint = validateEndpoint(url)
    } catch (error) {
      if (!(error instanceof WebRTCError)) throw error
      this.notifyError(error)
      return
    }

    this.reconnectCount = 0
    this.conf.url = endpoint
    if (this.state === 'getting_codecs') return

    // Cleanup existing session
    this.cleanupSession()

    // Reset to running state and start with new URL
    this.transition('running')
    this.start()
  }
}
