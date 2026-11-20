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
    const { status } = response
    const type = status === 404 ? ErrorTypes.NOT_FOUND_ERROR : ErrorTypes.REQUEST_ERROR
    throw new WebRTCError(type, 'Unexpected WHEP response status', {
      phase: 'signaling',
      ...(status > 0 ? { httpStatus: status } : {}),
    })
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

  async sendOffer(offer: string, signal: AbortSignal, onSession: (session: WhepSession | null) => void): Promise<string> {
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
    }).then((res) => {
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
      return res.text()
    })
  }

  private sessionAuthHeader(session: WhepSession): Record<string, string> {
    return session.authenticated ? this.authHeader(session.url) : {}
  }

  async deleteSession(session: WhepSession, signal: AbortSignal): Promise<void> {
    const response = await fetch(session.url, { method: 'DELETE', signal, redirect: 'error', headers: this.sessionAuthHeader(session) })
    this.checkStatus(response, response.ok)
  }

  async sendLocalCandidates(session: WhepSession, offerData: ParsedOffer, candidates: RTCIceCandidate[], signal: AbortSignal): Promise<void> {
    const body = SdpUtils.generateSdpFragment(offerData, candidates)
    if (!body)
      return

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
    this.checkStatus(response, response.status === 204)
  }
}
