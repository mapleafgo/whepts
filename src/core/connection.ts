import type { ParsedOffer } from '../utils/sdp'
import type { State } from '~/types'
import { ErrorTypes, WebRTCError } from '~/errors'
import { SdpUtils } from '../utils/sdp'

export interface ConnectionManagerCallbacks {
  onCandidate: (candidate: RTCIceCandidate) => void
  onTrack: (evt: RTCTrackEvent) => void
  onError: (err: WebRTCError) => void
}

export class ConnectionManager {
  private pc?: RTCPeerConnection
  private offerData?: ParsedOffer

  constructor(
    private getState: () => State,
    private callbacks: ConnectionManagerCallbacks,
    private getNonAdvertisedCodecs: () => string[],
  ) {}

  async setupPeerConnection(iceServers: RTCIceServer[]): Promise<string> {
    if (this.getState() !== 'running')
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
    pc.ontrack = (evt: RTCTrackEvent) => this.callbacks.onTrack(evt)

    return pc.createOffer().then((offer) => {
      if (!offer.sdp)
        throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Failed to create offer SDP')

      offer.sdp = SdpUtils.editOffer(offer.sdp, this.getNonAdvertisedCodecs())
      this.offerData = SdpUtils.parseOffer(offer.sdp)

      return pc.setLocalDescription(offer).then(() => offer.sdp!)
    })
  }

  async setAnswer(answer: string): Promise<void> {
    if (this.getState() !== 'running')
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
    if (this.getState() !== 'running')
      return

    if (evt.candidate)
      this.callbacks.onCandidate(evt.candidate)
  }

  private onConnectionState(): void {
    if (this.getState() !== 'running' || !this.pc)
      return

    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed')
      this.callbacks.onError(new WebRTCError(ErrorTypes.OTHER_ERROR, 'peer connection closed'))
  }

  private onIceConnectionState(): void {
    if (this.getState() !== 'running' || !this.pc)
      return

    console.warn(`ICE connection state: ${this.pc.iceConnectionState}`)

    if (this.pc.iceConnectionState === 'failed') {
      console.warn('ICE connection failed')
      this.pc.restartIce()
    }
  }
}
