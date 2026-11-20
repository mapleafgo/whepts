import type { ParsedOffer } from '../utils/sdp'
import type { State } from '~/types'
import { ErrorTypes, WebRTCError } from '~/errors'
import { SdpUtils } from '../utils/sdp'

export interface ConnectionManagerOptions {
  getState: () => State
  onCandidate: (candidate: RTCIceCandidate) => void
  onTrack: (event: RTCTrackEvent, pc: RTCPeerConnection) => void
  getNonAdvertisedCodecs: () => string[]
  disconnectGraceMs: number
  onConnected: () => void
  onTransportFailure: (wasConnected: boolean) => void
}

/**
 * WebRTC 连接管理器
 *
 * 负责管理 RTCPeerConnection 的生命周期和事件处理。
 */
export class ConnectionManager {
  private pc?: RTCPeerConnection
  private offerData?: ParsedOffer
  private wasConnected = false
  private disconnectTimer?: ReturnType<typeof setTimeout>

  constructor(private options: ConnectionManagerOptions) {}

  /**
   * 创建并配置 PeerConnection
   */
  async setupPeerConnection(iceServers: RTCIceServer[], signal: AbortSignal, waitForIce: boolean): Promise<string> {
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

    pc.onicecandidate = (event) => {
      if (this.pc === pc)
        this.handleIceCandidate(event)
    }
    pc.onconnectionstatechange = () => {
      if (this.pc === pc)
        this.handleConnectionState(pc)
    }
    pc.ontrack = (event) => {
      if (this.pc === pc)
        this.options.onTrack(event, pc)
    }

    return pc.createOffer().then(async (offer) => {
      signal.throwIfAborted()
      if (this.pc !== pc)
        throw new WebRTCError(ErrorTypes.STATE_ERROR, 'Peer connection was replaced')
      if (!offer.sdp)
        throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Failed to create offer SDP')

      offer.sdp = SdpUtils.editOffer(offer.sdp, this.options.getNonAdvertisedCodecs())
      this.offerData = SdpUtils.parseOffer(offer.sdp)

      await pc.setLocalDescription(offer)
      signal.throwIfAborted()
      if (!waitForIce)
        return offer.sdp

      await this.waitForIceGathering(pc, signal)
      const sdp = pc.localDescription?.sdp
      if (!sdp)
        throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Missing gathered offer SDP')
      return sdp
    })
  }

  private waitForIceGathering(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (pc.iceGatheringState === 'complete')
      return Promise.resolve()

    return new Promise((resolve, reject) => {
      const finish = (event: Event): void => {
        if (!signal.aborted && pc.iceGatheringState !== 'complete')
          return
        pc.removeEventListener('icegatheringstatechange', finish)
        signal.removeEventListener('abort', finish)
        if (event.type === 'abort' || signal.aborted)
          reject(signal.reason)
        else
          resolve()
      }
      pc.addEventListener('icegatheringstatechange', finish)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  /**
   * 设置远程 SDP Answer
   */
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
    this.detachPeer()?.close()
  }

  /** Detach the current peer without closing it; the caller owns its disposal. */
  detachPeer(): RTCPeerConnection | undefined {
    const pc = this.pc
    this.pc = undefined
    this.offerData = undefined
    this.wasConnected = false
    this.clearDisconnectTimer()
    if (!pc)
      return

    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    pc.ontrack = null
    return pc
  }

  /**
   * 处理本地 ICE 候选事件
   */
  private handleIceCandidate = (evt: RTCPeerConnectionIceEvent): void => {
    if (this.options.getState() !== 'running')
      return

    if (evt.candidate)
      this.options.onCandidate(evt.candidate)
  }

  private handleConnectionState(pc: RTCPeerConnection): void {
    const { connectionState } = pc
    if (connectionState === 'disconnected' && this.wasConnected) {
      this.disconnectTimer ??= setTimeout(() => {
        this.disconnectTimer = undefined
        if (this.pc === pc && pc.connectionState === 'disconnected')
          this.options.onTransportFailure(true)
      }, this.options.disconnectGraceMs)
      return
    }

    this.clearDisconnectTimer()
    if (connectionState === 'connected') {
      this.wasConnected = true
      this.options.onConnected()
    }
    else if (connectionState === 'failed') {
      this.options.onTransportFailure(this.wasConnected)
    }
  }

  private clearDisconnectTimer(): void {
    clearTimeout(this.disconnectTimer)
    this.disconnectTimer = undefined
  }
}
