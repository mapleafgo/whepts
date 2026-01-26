import type EventEmitter from 'eventemitter3'
import type { ParsedOffer } from '../utils/sdp'
import type { Conf, State } from '~/types'
import { ErrorTypes, WebRTCError } from '~/errors'
import { SdpUtils } from '../utils/sdp'
import { WebRtcUtils } from '../utils/webrtc'

export interface HttpClientOptions {
  conf: Conf
  getState: () => State
  emitter: EventEmitter
}

export class HttpClient {
  constructor(private options: HttpClientOptions) {}

  private authHeader(): Record<string, string> {
    if (this.options.conf.user && this.options.conf.user !== '') {
      const credentials = btoa(`${this.options.conf.user}:${this.options.conf.pass}`)
      return { Authorization: `Basic ${credentials}` }
    }
    if (this.options.conf.token && this.options.conf.token !== '') {
      return { Authorization: `Bearer ${this.options.conf.token}` }
    }
    return {}
  }

  async requestICEServers(): Promise<RTCIceServer[]> {
    if (this.options.conf.iceServers && this.options.conf.iceServers.length > 0)
      return this.options.conf.iceServers

    return fetch(this.options.conf.url, {
      method: 'OPTIONS',
      headers: {
        ...this.authHeader(),
      },
    }).then(res => WebRtcUtils.linkToIceServers(res.headers.get('Link')))
  }

  async sendOffer(offer: string): Promise<{ sessionUrl?: string, answer: string }> {
    if (this.options.getState() !== 'running')
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')

    return fetch(this.options.conf.url, {
      method: 'POST',
      headers: {
        ...this.authHeader(),
        'Content-Type': 'application/sdp',
      },
      body: offer,
    }).then((res) => {
      switch (res.status) {
        case 201:
          break
        case 404:
        case 406:
          throw new WebRTCError(ErrorTypes.NOT_FOUND_ERROR, 'stream not found')
        case 400:
          return res.json().then((e: { error: string }) => {
            throw new WebRTCError(ErrorTypes.REQUEST_ERROR, e.error)
          })
        default:
          throw new WebRTCError(ErrorTypes.REQUEST_ERROR, `bad status code ${res.status}`)
      }

      const location = res.headers.get('Location')
      const sessionUrl = location
        ? new URL(location, this.options.conf.url).toString()
        : undefined
      return res.text().then(answer => ({ sessionUrl, answer }))
    })
  }

  sendLocalCandidates(sessionUrl: string, offerData: ParsedOffer, candidates: RTCIceCandidate[]): void {
    fetch(sessionUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/trickle-ice-sdpfrag',
        'If-Match': '*',
      },
      body: SdpUtils.generateSdpFragment(offerData, candidates),
    })
      .then((res) => {
        switch (res.status) {
          case 204:
            break
          case 404:
            throw new WebRTCError(ErrorTypes.NOT_FOUND_ERROR, 'stream not found')
          default:
            throw new WebRTCError(ErrorTypes.REQUEST_ERROR, `bad status code ${res.status}`)
        }
      })
      .catch(err => this.options.emitter.emit('error', err))
  }
}
