import type { Conf, State, WhepEvents } from './types'
import EventEmitter from 'eventemitter3'
import { CodecDetector } from './core/codec'
import { ConnectionManager } from './core/connection'
import { HttpClient } from './core/http'
import { TrackManager } from './core/track'
import { ErrorTypes, WebRTCError } from './errors'
import { FlowCheck } from './utils/flow-check'

/** WebRTC/WHEP reader. */
export default class WebRTCWhep extends EventEmitter<WhepEvents> {
  private retryPause: number = 2000
  private conf: Conf
  private state: State
  private restartTimeout?: ReturnType<typeof setTimeout>
  private sessionUrl?: string
  private queuedCandidates: RTCIceCandidate[] = []
  private nonAdvertisedCodecs: string[] = []
  private flowCheck: FlowCheck
  private httpClient: HttpClient
  private connectionManager: ConnectionManager
  private trackManager: TrackManager
  private codecDetector: CodecDetector

  constructor(conf: Conf) {
    super()
    this.conf = conf
    this.state = 'getting_codecs'

    this.trackManager = new TrackManager(this.conf.container)

    this.flowCheck = new FlowCheck({
      interval: 5000,
      emitter: this,
    })

    this.httpClient = new HttpClient({
      conf: this.conf,
      getState: () => this.state,
      emitter: this,
    })

    this.connectionManager = new ConnectionManager({
      getState: () => this.state,
      emitter: this,
      getNonAdvertisedCodecs: () => this.nonAdvertisedCodecs,
    })

    this.codecDetector = new CodecDetector({
      getState: () => this.state,
      emitter: this,
    })

    // Listen to codec detection events
    this.on('codecs:detected', (codecs: string[]) => {
      this.handleCodecsDetected(codecs)
    })

    // Listen to connection events
    this.on('candidate', (candidate: RTCIceCandidate) => this.handleCandidate(candidate))
    this.on('track', (evt: RTCTrackEvent) => {
      this.trackManager.onTrack(evt)
      this.flowCheck.start()
    })

    this.codecDetector.detect()
  }

  get isRunning(): boolean {
    return this.state === 'running'
  }

  close(): void {
    this.state = 'closed'
    this.connectionManager.close()
    this.trackManager.stop()
    this.flowCheck.close()
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
    }
  }

  private handleError(err: Error | WebRTCError): void {
    this.flowCheck.close()

    if (this.state === 'getting_codecs') {
      this.state = 'failed'
    }
    else if (err instanceof WebRTCError && [ErrorTypes.SIGNAL_ERROR, ErrorTypes.NOT_FOUND_ERROR, ErrorTypes.REQUEST_ERROR].includes(err.type)) {
      this.state = 'failed'
    }
    else if (this.state === 'running') {
      this.connectionManager.close()
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

  private handleCodecsDetected(codecs: string[]): void {
    this.nonAdvertisedCodecs = codecs
    this.state = 'running'
    this.start()
  }

  private start(): void {
    this.httpClient.requestICEServers()
      .then(iceServers => this.connectionManager.setupPeerConnection(iceServers))
      .then((offer) => {
        const pc = this.connectionManager.getPeerConnection()
        if (pc)
          this.flowCheck.setPeerConnection(pc)
        return offer
      })
      .then(offer => this.httpClient.sendOffer(offer))
      .then(({ sessionUrl, answer }) => this.handleOfferResponse(sessionUrl, answer))
      .catch(err => this.handleError(err))
  }

  private handleOfferResponse(sessionUrl: string | undefined, answer: string): Promise<void> {
    if (sessionUrl)
      this.sessionUrl = sessionUrl

    return this.connectionManager.setAnswer(answer).then(() => {
      if (this.state !== 'running')
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
}
