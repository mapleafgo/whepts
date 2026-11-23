import type { ParsedOffer } from '../utils/sdp'
import type { Conf, State } from '~/types'
import { ErrorTypes, WebRTCError } from '~/errors'
import { SdpUtils } from '../utils/sdp'
import { WebRtcUtils } from '../utils/webrtc'

export interface WhepSession {
  url: string
  etag: string | null
  authenticated: boolean
}

export interface HttpClientOptions {
  conf: Conf
  getState: () => State
}

const DEFAULT_COUNTER_OFFER_LIFETIME_MS = 30000

/** Read the Content-Type valid-until parameter, defaulting to 30 seconds from now. */
function readValidUntil(contentType: string): number {
  const match = /;\s*valid-until\s*=\s*"?([^";]+)"?/i.exec(contentType)
  const parsed = match ? Date.parse(match[1]) : Number.NaN
  return Number.isNaN(parsed) ? Date.now() + DEFAULT_COUNTER_OFFER_LIFETIME_MS : parsed
}

export class HttpClient {
  private readonly credentialOrigin: string | undefined

  constructor(private options: HttpClientOptions) {
    this.credentialOrigin = URL.canParse(options.conf.url) ? new URL(options.conf.url).origin : undefined
  }

  private checkStatus(response: Response, accepted: boolean): void {
    if (accepted)
      return

    // 响应正文可能包含服务端内部信息，不作为公开错误来源。
    void response.body?.cancel().catch(() => {})
    throw this.statusError(response.status)
  }

  /** Map any unexpected status to the generic request failure; callers read httpStatus. */
  private statusError(status: number): WebRTCError {
    // 草案 §4.1：不得把状态码映射到具体原因，统一交由 httpStatus 表达。
    return new WebRTCError(ErrorTypes.REQUEST_ERROR, 'Unexpected WHEP response status', {
      phase: 'signaling',
      ...(status > 0 ? { httpStatus: status } : {}),
    })
  }

  /** Send the SDP answer to a server counter-offer. */
  async sendAnswer(session: WhepSession, answer: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(session.url, {
      method: 'PATCH',
      redirect: 'error',
      signal,
      headers: {
        ...this.sessionAuthHeader(session),
        'Content-Type': 'application/sdp',
      },
      body: answer,
    })
    this.checkStatus(response, response.status === 204)
  }

  private authHeader(url: string): Record<string, string> {
    if (!this.credentialOrigin || this.credentialOrigin === 'null' || !URL.canParse(url) || new URL(url).origin !== this.credentialOrigin)
      return {}

    if (this.options.conf.user && this.options.conf.user !== '') {
      const credentials = btoa(`${this.options.conf.user}:${this.options.conf.pass ?? ''}`)
      return { Authorization: `Basic ${credentials}` }
    }
    if (this.options.conf.token && this.options.conf.token !== '') {
      return { Authorization: `Bearer ${this.options.conf.token}` }
    }
    return {}
  }

  async requestICEServers(signal: AbortSignal): Promise<RTCIceServer[]> {
    if (this.options.conf.iceServers && this.options.conf.iceServers.length > 0)
      return this.options.conf.iceServers

    return fetch(this.options.conf.url, {
      method: 'OPTIONS',
      signal,
      headers: {
        ...this.authHeader(this.options.conf.url),
      },
    }).then((response) => {
      this.checkStatus(response, response.ok)
      return WebRtcUtils.linkToIceServers(response.headers.get('Link'))
    })
  }

  /**
   * POST the client offer.
   * Returns an answer body, or a counter-offer when the endpoint answered 406 with usable SDP.
   */
  async sendOffer(offer: string, signal: AbortSignal, onSession: (session: WhepSession | null) => void): Promise<{ answer: string } | { counterOffer: string, expiresAt: number }> {
    if (this.options.getState() !== 'running')
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')

    const endpoint = this.options.conf.url
    return fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        ...this.authHeader(endpoint),
        'Content-Type': 'application/sdp',
      },
      body: offer,
    }).then(async (res) => {
      const counterCandidate = res.status === 406
      if (!counterCandidate)
        this.checkStatus(res, res.status === 201)

      const location = res.headers.get('Location')
      const base = res.url || endpoint
      const url = location && URL.canParse(location, base) ? new URL(location, base) : undefined
      const usable = url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      onSession(usable
        ? { url: url.href, etag: res.headers.get('ETag'), authenticated: new URL(endpoint).origin === url.origin && new URL(base).origin === url.origin }
        : null)
      if (signal.aborted) {
        void res.body?.cancel().catch(() => {})
        signal.throwIfAborted()
      }
      const body = await res.text()
      if (!counterCandidate)
        return { answer: body }

      // 草案 §4.3.3：只有带 application/sdp 和合法 SDP offer 的 406 才是反向 offer。
      const contentType = res.headers.get('Content-Type') ?? ''
      if (!usable || !contentType.toLowerCase().startsWith('application/sdp') || !SdpUtils.isSdpOffer(body)) {
        void res.body?.cancel().catch(() => {})
        throw this.statusError(res.status)
      }
      // 草案 §4.3.2：未提供 valid-until 时反向 offer 只保留 30 秒。
      return { counterOffer: body, expiresAt: readValidUntil(contentType) }
    })
  }

  private sessionAuthHeader(session: WhepSession): Record<string, string> {
    return session.authenticated ? this.authHeader(session.url) : {}
  }

  async deleteSession(session: WhepSession, signal: AbortSignal): Promise<void> {
    const response = await fetch(session.url, { method: 'DELETE', signal, redirect: 'error', headers: this.sessionAuthHeader(session) })
    this.checkStatus(response, response.ok)
  }

  /**
   * Send one ICE fragment.
   * Returns the rotated entity tag when the session answered a 200 (ICE restart) or null.
   */
  async sendLocalCandidates(session: WhepSession, offerData: ParsedOffer, candidates: RTCIceCandidate[], signal: AbortSignal): Promise<string | null> {
    const body = SdpUtils.generateSdpFragment(offerData, candidates)
    if (!body)
      return null

    const response = await fetch(session.url, {
      method: 'PATCH',
      redirect: 'error',
      signal,
      headers: {
        ...this.sessionAuthHeader(session),
        'Content-Type': 'application/trickle-ice-sdpfrag',
        'If-Match': session.etag || '*',
      },
      body,
    })
    // 草案 §4.5.3：ICE 重启成功返回 200 + 新 ETag；普通候选聚合返回 204。
    this.checkStatus(response, response.status === 204 || response.status === 200)
    return response.status === 200 ? response.headers.get('ETag') : null
  }
}
