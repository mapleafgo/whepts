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

/**
 * WebRTC 连接管理器
 *
 * 负责管理 RTCPeerConnection 的生命周期和事件处理。
 */
export class ConnectionManager {
  private pc?: RTCPeerConnection
  private offerData?: ParsedOffer

  constructor(private options: ConnectionManagerOptions) {}

  /**
   * 创建并配置 PeerConnection
   */
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

    // 注册事件处理器（使用类方法引用，便于管理和清理）
    pc.onicecandidate = this.handleIceCandidate
    pc.onconnectionstatechange = this.handleConnectionState
    pc.oniceconnectionstatechange = this.handleIceConnectionState
    pc.ontrack = this.handleTrack

    return pc.createOffer().then((offer) => {
      if (!offer.sdp)
        throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Failed to create offer SDP')

      offer.sdp = SdpUtils.editOffer(offer.sdp, this.options.getNonAdvertisedCodecs())
      this.offerData = SdpUtils.parseOffer(offer.sdp)

      return pc.setLocalDescription(offer).then(() => offer.sdp!)
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
    this.pc?.close()
    this.pc = undefined
    this.offerData = undefined
  }

  /**
   * 处理本地 ICE 候选事件
   */
  private handleIceCandidate = (evt: RTCPeerConnectionIceEvent): void => {
    if (this.options.getState() !== 'running')
      return

    if (evt.candidate)
      this.options.emitter.emit('candidate', evt.candidate)
  }

  /**
   * 处理连接状态变化
   *
   * connectionState 可能的值：
   * - 'new': 刚创建，还未连接
   * 'connecting': 正在连接中
   * 'connected': 已连接
   * - 'disconnected': 已断开（可能短暂）
   * - 'failed': 连接失败
   * - 'closed': 已关闭
   *
   * 连接失败或关闭属于流断开，触发 flow:stalled 事件进行恢复。
   */
  private handleConnectionState = (): void => {
    if (this.options.getState() !== 'running' || !this.pc)
      return

    const { connectionState } = this.pc

    // 连接失败或关闭，触发流停滞事件
    if (connectionState === 'failed' || connectionState === 'closed') {
      this.options.emitter.emit('flow:stalled', {
        reason: `peer connection ${connectionState}`,
      })
    }
  }

  /**
   * 处理 ICE 连接状态变化
   *
   * iceConnectionState 可能的值：
   * - 'new': 刚创建，还未检查
   * - 'checking': 正在检查
   * 'connected': ICE 连接成功
   * 'completed': ICE 连接完成
   * 'failed': ICE 连接失败
   * 'disconnected': ICE 连接断开（可能短暂）
   */
  private handleIceConnectionState = (): void => {
    if (this.options.getState() !== 'running' || !this.pc)
      return

    const { iceConnectionState } = this.pc

    // ICE 连接失败，尝试重启 ICE
    if (iceConnectionState === 'failed') {
      this.restartIceConnection()
    }
  }

  /**
   * 处理媒体轨道事件
   */
  private handleTrack = (evt: RTCTrackEvent): void => {
    this.options.emitter.emit('track', evt)
  }

  /**
   * 重启 ICE 连接
   *
   * 当 ICE 连接失败时，尝试重启 ICE 以恢复连接
   */
  private restartIceConnection(): void {
    if (!this.pc)
      return

    try {
      this.pc.restartIce()
    }
    catch (error) {
      console.error('[ConnectionManager] ICE restart failed:', error)
    }
  }
}
