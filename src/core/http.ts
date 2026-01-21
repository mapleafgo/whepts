import type { ParsedOffer } from '../utils/sdp'
import type { Conf, State } from '~/types'
import { ErrorTypes, WebRTCError } from '~/errors'
import { SdpUtils } from '../utils/sdp'
import { WebRtcUtils } from '../utils/webrtc'

export class HttpClient {
  constructor(
    private config: Conf,
    private getState: () => State,
    private onError: (err: Error | WebRTCError) => void,
  ) {}

  private authHeader(): Record<string, string> {
    if (this.config.user && this.config.user !== '') {
      const credentials = btoa(`${this.config.user}:${this.config.pass}`)
      return { Authorization: `Basic ${credentials}` }
    }
    if (this.config.token && this.config.token !== '') {
      return { Authorization: `Bearer ${this.config.token}` }
    }
    return {}
  }

  async requestICEServers(): Promise<RTCIceServer[]> {
    if (this.config.iceServers && this.config.iceServers.length > 0)
      return this.config.iceServers

    return fetch(this.config.url, {
      method: 'OPTIONS',
      headers: {
        ...this.authHeader(),
      },
    }).then(res => WebRtcUtils.linkToIceServers(res.headers.get('Link')))
  }

  async sendOffer(offer: string): Promise<{ sessionUrl?: string, answer: string }> {
    if (this.getState() !== 'running')
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')

    return fetch(this.config.url, {
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
        ? new URL(location, this.config.url).toString()
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
      .catch(err => this.onError(err))
  }
}
