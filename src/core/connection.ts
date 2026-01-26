import type EventEmitter from 'eventemitter3'
import type { ParsedOffer } from '../utils/sdp'
import type { State } from '~/types'
import { ErrorTypes, WebRTCError } from '~/errors'
import { SdpUtils } from '../utils/sdp'

export interface ConnectionManagerOptions {
  getState: () => State
  emitter: EventEmitter
  getNonAdvertisedCodecs: () => string[]
}

export class ConnectionManager {
  private pc?: RTCPeerConnection
  private offerData?: ParsedOffer

  constructor(private options: ConnectionManagerOptions) {}

  async setupPeerConnection(iceServers: RTCIceServer[]): Promise<string> {
    if (this.options.getState() !== 'running')
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')

    const pc = new RTCPeerConnection({
      iceServers,
      sdpSemantics: 'unified-plan',
    })
    this.pc = pc

    const direction: RTCRtpTransceiverDirection = 'recvonly'
    pc.addTransceiver('video', { direction })
    pc.addTransceiver('audio', { direction })

    pc.onicecandidate = (evt: RTCPeerConnectionIceEvent) => this.onLocalCandidate(evt)
    pc.onconnectionstatechange = () => this.onConnectionState()
    pc.oniceconnectionstatechange = () => this.onIceConnectionState()
    pc.ontrack = (evt: RTCTrackEvent) => this.options.emitter.emit('track', evt)

    return pc.createOffer().then((offer) => {
      if (!offer.sdp)
        throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Failed to create offer SDP')

      offer.sdp = SdpUtils.editOffer(offer.sdp, this.options.getNonAdvertisedCodecs())
      this.offerData = SdpUtils.parseOffer(offer.sdp)

      return pc.setLocalDescription(offer).then(() => offer.sdp!)
    })
  }

  async setAnswer(answer: string): Promise<void> {
    if (this.options.getState() !== 'running')
      throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')

    return this.pc!.setRemoteDescription(
      new RTCSessionDescription({
        type: 'answer',
        sdp: answer,
      }),
    )
  }

  getPeerConnection(): RTCPeerConnection | undefined {
    return this.pc
  }

  getOfferData(): ParsedOffer | undefined {
    return this.offerData
  }

  close(): void {
    this.pc?.close()
    this.pc = undefined
    this.offerData = undefined
  }

  private onLocalCandidate(evt: RTCPeerConnectionIceEvent): void {
    if (this.options.getState() !== 'running')
      return

    if (evt.candidate)
      this.options.emitter.emit('candidate', evt.candidate)
  }

  private onConnectionState(): void {
    if (this.options.getState() !== 'running' || !this.pc)
      return

    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed')
      this.options.emitter.emit('error', new WebRTCError(ErrorTypes.OTHER_ERROR, 'peer connection closed'))
  }

  private onIceConnectionState(): void {
    if (this.options.getState() !== 'running' || !this.pc)
      return

    console.warn(`ICE connection state: ${this.pc.iceConnectionState}`)

    if (this.pc.iceConnectionState === 'failed') {
      console.warn('ICE connection failed')
      this.pc.restartIce()
    }
  }
}
