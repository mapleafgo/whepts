import type { ParsedOffer } from './utils/sdp'
import VisibilityObserver from '~/utils/observer'
import { ErrorTypes, WebRTCError } from './errors'
import { FlowCheck } from './utils/flow-check'
import { SdpUtils } from './utils/sdp'
import { WebRtcUtils } from './utils/webrtc'

/**
 * Configuration interface for WebRTCWhep.
 */
export interface Conf {
  /** Absolute URL of the WHEP endpoint */
  url: string
  /** Media player container */
  container: HTMLMediaElement
  /** Username for authentication */
  user?: string
  /** Password for authentication */
  pass?: string
  /** Token for authentication */
  token?: string
  /** ice server list */
  iceServers?: RTCIceServer[]
  /** Called when there's an error */
  onError?: (err: WebRTCError) => void
}

/** Extend RTCConfiguration to include experimental properties */
declare global {
  interface RTCConfiguration {
    sdpSemantics?: 'plan-b' | 'unified-plan'
  }

  interface RTCIceServer {
    credentialType?: 'password'
  }
}

/** WebRTC/WHEP reader. */
export default class WebRTCWhep {
  private retryPause: number = 2000
  private conf: Conf
  private state: 'getting_codecs' | 'running' | 'restarting' | 'closed' | 'failed'
  private restartTimeout?: NodeJS.Timeout
  private pc?: RTCPeerConnection
  private offerData?: ParsedOffer
  private sessionUrl?: string
  private queuedCandidates: RTCIceCandidate[] = []
  private nonAdvertisedCodecs: string[] = []
  private observer: VisibilityObserver
  private stream?: MediaStream
  private flowCheck: FlowCheck

  /**
   * Create a WebRTCWhep.
   * @param {Conf} conf - Configuration.
   */
  constructor(conf: Conf) {
    this.conf = conf
    this.state = 'getting_codecs'
    this.observer = new VisibilityObserver()
    this.flowCheck = new FlowCheck({
      interval: 5000,
      onError: (err: WebRTCError) => this.handleError(err),
    })
    this.getNonAdvertisedCodecs()
  }

  /**
   * 媒体是否正常
   */
  get isRunning(): boolean {
    return this.state === 'running'
  }

  /**
   * Close the reader and all its resources.
   */
  close(): void {
    this.state = 'closed'
    this.pc?.close()

    this.observer.stop()
    this.flowCheck.stop()
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
    }
  }

  /**
   * Handle errors.
   */
  private handleError(err: Error | WebRTCError): void {
    this.flowCheck.stop()

    if (this.state === 'getting_codecs') {
      this.state = 'failed'
    }
    else if (err instanceof WebRTCError && err.type === ErrorTypes.SIGNAL_ERROR) {
      this.state = 'failed'
    }
    else if (this.state === 'running') {
      this.pc?.close()
      this.pc = undefined

      this.offerData = undefined
      this.queuedCandidates = []

      if (this.sessionUrl) {
        fetch(this.sessionUrl, {
          method: 'DELETE',
        })
        this.sessionUrl = undefined
      }

      this.state = 'restarting'

      this.restartTimeout = setTimeout(() => {
        this.restartTimeout = undefined
        this.state = 'running'
        this.start()
      }, this.retryPause)

      err.message = `${err.message}, retrying in some seconds`
    }

    if (this.conf.onError) {
      if (err instanceof WebRTCError) {
        this.conf.onError(err)
      }
      else {
        this.conf.onError(new WebRTCError(ErrorTypes.OTHER_ERROR, err.message))
      }
    }
  }

  /**
   * Get non-advertised codecs.
   */
  private getNonAdvertisedCodecs(): void {
    Promise.all(
      [
        ['pcma/8000/2'],
        ['multiopus/48000/6', 'channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2'],
        ['L16/48000/2'],
      ].map(c => WebRtcUtils.supportsNonAdvertisedCodec(c[0], c[1]).then(r => (r ? c[0] : false))),
    )
      .then(c => c.filter(e => e !== false))
      .then((codecs) => {
        if (this.state !== 'getting_codecs') {
          throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')
        }

        this.nonAdvertisedCodecs = codecs as string[]
        this.state = 'running'
        this.start()
      })
      .catch(err => this.handleError(err))
  }

  /**
   * Start the WebRTC session.
   */
  private start(): void {
    this.requestICEServers()
      .then(iceServers => this.setupPeerConnection(iceServers))
      .then(offer => this.sendOffer(offer))
      .then(answer => this.setAnswer(answer))
      .catch(err => this.handleError(err))
  }

  /**
   * Generate an authorization header.
   */
  private authHeader(): Record<string, string> {
    if (this.conf.user && this.conf.user !== '') {
      const credentials = btoa(`${this.conf.user}:${this.conf.pass}`)
      return { Authorization: `Basic ${credentials}` }
    }
    if (this.conf.token && this.conf.token !== '') {
      return { Authorization: `Bearer ${this.conf.token}` }
    }
    return {}
  }

  /**
   * Request ICE servers from the endpoint.
   */
  private async requestICEServers(): Promise<RTCIceServer[]> {
    if (this.conf.iceServers && this.conf.iceServers.length > 0) {
      return this.conf.iceServers
    }

    return fetch(this.conf.url, {
      method: 'OPTIONS',
      headers: {
        ...this.authHeader(),
      },
    }).then(res => WebRtcUtils.linkToIceServers(res.headers.get('Link')))
  }

  /**
   * Setup a peer connection.
   */
  private async setupPeerConnection(iceServers: RTCIceServer[]): Promise<string> {
    if (this.state !== 'running') {
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')
    }

    const pc = new RTCPeerConnection({
      iceServers,
      // https://webrtc.org/getting-started/unified-plan-transition-guide
      sdpSemantics: 'unified-plan',
    })
    this.pc = pc
    this.flowCheck.setPeerConnection(pc)

    const direction: RTCRtpTransceiverDirection = 'recvonly'
    pc.addTransceiver('video', { direction })
    pc.addTransceiver('audio', { direction })

    pc.onicecandidate = (evt: RTCPeerConnectionIceEvent) => this.onLocalCandidate(evt)
    pc.onconnectionstatechange = () => this.onConnectionState()
    pc.ontrack = (evt: RTCTrackEvent) => this.onTrack(evt)

    return pc.createOffer().then((offer) => {
      if (!offer.sdp) {
        throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Failed to create offer SDP')
      }

      offer.sdp = SdpUtils.editOffer(offer.sdp, this.nonAdvertisedCodecs)
      this.offerData = SdpUtils.parseOffer(offer.sdp)

      return pc.setLocalDescription(offer).then(() => offer.sdp!)
    })
  }

  /**
   * Send an offer to the endpoint.
   */
  private sendOffer(offer: string): Promise<string> {
    if (this.state !== 'running') {
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')
    }

    return fetch(this.conf.url, {
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
          throw new WebRTCError(ErrorTypes.NETWORK_ERROR, 'stream not found')
        case 406:
          throw new WebRTCError(ErrorTypes.NETWORK_ERROR, 'stream not supported')
        case 400:
          return res.json().then((e: { error: string }) => {
            throw new WebRTCError(ErrorTypes.NETWORK_ERROR, e.error)
          })
        default:
          throw new WebRTCError(ErrorTypes.NETWORK_ERROR, `bad status code ${res.status}`)
      }

      const location = res.headers.get('Location')
      if (location) {
        this.sessionUrl = new URL(location, this.conf.url).toString()
      }

      return res.text()
    })
  }

  /**
   * Set a remote answer.
   */
  private setAnswer(answer: string): Promise<void> {
    if (this.state !== 'running') {
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')
    }

    return this.pc!.setRemoteDescription(
      new RTCSessionDescription({
        type: 'answer',
        sdp: answer,
      }),
    ).then(() => {
      if (this.state !== 'running') {
        return
      }

      if (this.queuedCandidates.length !== 0) {
        this.sendLocalCandidates(this.queuedCandidates)
        this.queuedCandidates = []
      }
    })
  }

  /**
   * Handle local ICE candidates.
   */
  private onLocalCandidate(evt: RTCPeerConnectionIceEvent): void {
    if (this.state !== 'running') {
      return
    }

    if (evt.candidate) {
      if (this.sessionUrl) {
        this.sendLocalCandidates([evt.candidate])
      }
      else {
        this.queuedCandidates.push(evt.candidate)
      }
    }
  }

  /**
   * Send local ICE candidates to the endpoint.
   */
  private sendLocalCandidates(candidates: RTCIceCandidate[]): void {
    if (!this.sessionUrl || !this.offerData) {
      return
    }

    fetch(this.sessionUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/trickle-ice-sdpfrag',
        'If-Match': '*',
      },
      body: SdpUtils.generateSdpFragment(this.offerData, candidates),
    })
      .then((res) => {
        switch (res.status) {
          case 204:
            break
          case 404:
            throw new WebRTCError(ErrorTypes.NETWORK_ERROR, 'stream not found')
          default:
            throw new WebRTCError(ErrorTypes.NETWORK_ERROR, `bad status code ${res.status}`)
        }
      })
      .catch(err => this.handleError(err))
  }

  /**
   * Handle peer connection state changes.
   */
  private onConnectionState(): void {
    if (this.state !== 'running' || !this.pc) {
      return
    }

    // "closed" can arrive before "failed" and without
    // the close() method being called at all.
    // It happens when the other peer sends a termination
    // message like a DTLS CloseNotify.
    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
      this.handleError(new WebRTCError(ErrorTypes.OTHER_ERROR, 'peer connection closed'))
    }
    else if (this.pc.connectionState === 'connected') {
      this.flowCheck.start()
    }
  }

  /**
   * Handle incoming tracks.
   */
  private onTrack(evt: RTCTrackEvent): void {
    this.stream = evt.streams[0]
    this.observer.start(this.conf.container, (isIntersecting) => {
      if (isIntersecting)
        this.resume()
      else
        this.pause()
    })
  }

  /**
   * 流是否为空
   */
  get paused() {
    return this.conf.container.srcObject === null
  }

  /**
   * 暂停播放
   */
  pause() {
    this.conf.container.srcObject = null
  }

  /**
   * 恢复播放
   */
  resume() {
    if (this.stream && this.paused)
      this.conf.container.srcObject = this.stream
  }
}
