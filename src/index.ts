import VisibilityObserver from '~/utils/observer'

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

/** Type for parsed offer data */
interface ParsedOffer {
  iceUfrag: string
  icePwd: string
  medias: string[]
}

/**
 * 错误类型
 */
export type ErrorType = string

/**
 * 错误类型常量
 */
export const ErrorTypes = {
  SIGNAL_ERROR: 'SignalError', // 信令异常
  STATE_ERROR: 'StateError', // 状态异常
  NETWORK_ERROR: 'NetworkError',
  MEDIA_ERROR: 'MediaError',
  OTHER_ERROR: 'OtherError',
}

/**
 * 错误
 */
export class WebRTCError extends Error {
  type: ErrorType

  constructor(type: ErrorType, message: string, options?: ErrorOptions) {
    super(message, options)
    this.type = type
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
  private container: HTMLMediaElement
  private observer: VisibilityObserver
  private stream?: MediaStream
  /**
   * 断连重试参数
   */
  private checkInterval: number = 5000
  private lastBytesReceived: number = 0
  private checkTimer?: NodeJS.Timeout

  /**
   * Create a WebRTCWhep.
   * @param {Conf} conf - Configuration.
   */
  constructor(conf: Conf) {
    this.conf = conf
    this.state = 'getting_codecs'
    this.container = conf.container
    this.observer = new VisibilityObserver()
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
    this.stopFlowCheck()
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
    }
  }

  /**
   * Check if the browser supports a non-advertised codec.
   */
  private static async supportsNonAdvertisedCodec(codec: string, fmtp?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const pc = new RTCPeerConnection({ iceServers: [] })
      const mediaType = 'audio'
      let payloadType = ''

      pc.addTransceiver(mediaType, { direction: 'recvonly' })
      pc.createOffer()
        .then((offer) => {
          if (!offer.sdp) {
            throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'SDP not present')
          }
          if (offer.sdp.includes(` ${codec}`)) {
            // codec is advertised, there's no need to add it manually
            throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'already present')
          }

          const sections = offer.sdp.split(`m=${mediaType}`)

          const payloadTypes = sections
            .slice(1)
            .map(s => s.split('\r\n')[0].split(' ').slice(3))
            .reduce((prev, cur) => [...prev, ...cur], [])
          payloadType = WebRTCWhep.reservePayloadType(payloadTypes)

          const lines = sections[1].split('\r\n')
          lines[0] += ` ${payloadType}`
          lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} ${codec}`)
          if (fmtp !== undefined) {
            lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} ${fmtp}`)
          }
          sections[1] = lines.join('\r\n')
          offer.sdp = sections.join(`m=${mediaType}`)
          return pc.setLocalDescription(offer)
        })
        .then(() =>
          pc.setRemoteDescription(
            new RTCSessionDescription({
              type: 'answer',
              sdp:
                `v=0\r\n`
                + `o=- 6539324223450680508 0 IN IP4 0.0.0.0\r\n`
                + `s=-\r\n`
                + `t=0 0\r\n`
                + `a=fingerprint:sha-256 0D:9F:78:15:42:B5:4B:E6:E2:94:3E:5B:37:78:E1:4B:54:59:A3:36:3A:E5:05:EB:27:EE:8F:D2:2D:41:29:25\r\n`
                + `m=${mediaType} 9 UDP/TLS/RTP/SAVPF ${payloadType}\r\n`
                + `c=IN IP4 0.0.0.0\r\n`
                + `a=ice-pwd:7c3bf4770007e7432ee4ea4d697db675\r\n`
                + `a=ice-ufrag:29e036dc\r\n`
                + `a=sendonly\r\n`
                + `a=rtcp-mux\r\n`
                + `a=rtpmap:${payloadType} ${codec}\r\n${fmtp !== undefined ? `a=fmtp:${payloadType} ${fmtp}\r\n` : ''}`,
            }),
          ),
        )
        .then(() => resolve(true))
        .catch(() => resolve(false))
        .finally(() => pc.close())
    })
  }

  /**
   * Unquote a credential string.
   */
  private static unquoteCredential(v: string): string {
    return JSON.parse(`"${v}"`)
  }

  /**
   * Convert Link header to iceServers array.
   */
  private static linkToIceServers(links: string | null): RTCIceServer[] {
    if (links) {
      return links.split(', ').map((link) => {
        const m = link.match(
          /^<(.+?)>; rel="ice-server"(; username="(.*?)"; credential="(.*?)"; credential-type="password")?/i,
        )

        if (!m) {
          throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Invalid ICE server link format')
        }

        const ret: RTCIceServer = {
          urls: [m[1]],
        }

        if (m[3]) {
          ret.username = WebRTCWhep.unquoteCredential(m[3])
          ret.credential = WebRTCWhep.unquoteCredential(m[4])
          ret.credentialType = 'password'
        }

        return ret
      })
    }
    return []
  }

  /**
   * Parse an offer SDP into iceUfrag, icePwd, and medias.
   */
  private static parseOffer(sdp: string): ParsedOffer {
    const ret: ParsedOffer = {
      iceUfrag: '',
      icePwd: '',
      medias: [],
    }

    for (const line of sdp.split('\r\n')) {
      if (line.startsWith('m=')) {
        ret.medias.push(line.slice('m='.length))
      }
      else if (ret.iceUfrag === '' && line.startsWith('a=ice-ufrag:')) {
        ret.iceUfrag = line.slice('a=ice-ufrag:'.length)
      }
      else if (ret.icePwd === '' && line.startsWith('a=ice-pwd:')) {
        ret.icePwd = line.slice('a=ice-pwd:'.length)
      }
    }

    return ret
  }

  /**
   * Reserve a payload type.
   */
  private static reservePayloadType(payloadTypes: string[]): string {
    // everything is valid between 30 and 127, except for interval between 64 and 95
    // https://chromium.googlesource.com/external/webrtc/+/refs/heads/master/call/payload_type.h#29
    for (let i = 30; i <= 127; i++) {
      if ((i <= 63 || i >= 96) && !payloadTypes.includes(i.toString())) {
        const pl = i.toString()
        payloadTypes.push(pl)
        return pl
      }
    }
    throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'unable to find a free payload type')
  }

  /**
   * Enable stereo PCMA/PCMU codecs.
   */
  private static enableStereoPcmau(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    let payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} PCMU/8000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} PCMA/8000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    return lines.join('\r\n')
  }

  /**
   * Enable multichannel Opus codec.
   */
  private static enableMultichannelOpus(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    let payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/3`)
    lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} channel_mapping=0,2,1;num_streams=2;coupled_streams=1`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/4`)
    lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} channel_mapping=0,1,2,3;num_streams=2;coupled_streams=2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/5`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,4,1,2,3;num_streams=3;coupled_streams=2`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/6`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/7`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,4,1,2,3,5,6;num_streams=4;coupled_streams=4`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/8`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,6,1,4,5,2,3,7;num_streams=5;coupled_streams=4`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    return lines.join('\r\n')
  }

  /**
   * Enable L16 codec.
   */
  private static enableL16(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    let payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} L16/8000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} L16/16000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = WebRTCWhep.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} L16/48000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    return lines.join('\r\n')
  }

  /**
   * Enable stereo Opus codec.
   */
  private static enableStereoOpus(section: string): string {
    let opusPayloadFormat = ''
    const lines = section.split('\r\n')

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('a=rtpmap:') && lines[i].toLowerCase().includes('opus/')) {
        opusPayloadFormat = lines[i].slice('a=rtpmap:'.length).split(' ')[0]
        break
      }
    }

    if (opusPayloadFormat === '') {
      return section
    }

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`a=fmtp:${opusPayloadFormat} `)) {
        if (!lines[i].includes('stereo')) {
          lines[i] += ';stereo=1'
        }
        if (!lines[i].includes('sprop-stereo')) {
          lines[i] += ';sprop-stereo=1'
        }
      }
    }

    return lines.join('\r\n')
  }

  /**
   * Edit an offer SDP to enable non-advertised codecs.
   */
  private static editOffer(sdp: string, nonAdvertisedCodecs: string[]): string {
    const sections = sdp.split('m=')

    const payloadTypes = sections
      .slice(1)
      .map(s => s.split('\r\n')[0].split(' ').slice(3))
      .reduce((prev, cur) => [...prev, ...cur], [])

    for (let i = 1; i < sections.length; i++) {
      if (sections[i].startsWith('audio')) {
        sections[i] = WebRTCWhep.enableStereoOpus(sections[i])

        if (nonAdvertisedCodecs.includes('pcma/8000/2')) {
          sections[i] = WebRTCWhep.enableStereoPcmau(payloadTypes, sections[i])
        }
        if (nonAdvertisedCodecs.includes('multiopus/48000/6')) {
          sections[i] = WebRTCWhep.enableMultichannelOpus(payloadTypes, sections[i])
        }
        if (nonAdvertisedCodecs.includes('L16/48000/2')) {
          sections[i] = WebRTCWhep.enableL16(payloadTypes, sections[i])
        }

        break
      }
    }

    return sections.join('m=')
  }

  /**
   * Generate an SDP fragment.
   */
  private static generateSdpFragment(od: ParsedOffer, candidates: RTCIceCandidate[]): string {
    const candidatesByMedia: Record<number, RTCIceCandidate[]> = {}
    for (const candidate of candidates) {
      const mid = candidate.sdpMLineIndex
      if (mid) {
        if (candidatesByMedia[mid] === undefined) {
          candidatesByMedia[mid] = []
        }
        candidatesByMedia[mid].push(candidate)
      }
    }

    let frag = `a=ice-ufrag:${od.iceUfrag}\r\n` + `a=ice-pwd:${od.icePwd}\r\n`

    let mid = 0

    for (const media of od.medias) {
      if (candidatesByMedia[mid] !== undefined) {
        frag += `m=${media}\r\n` + `a=mid:${mid}\r\n`

        for (const candidate of candidatesByMedia[mid]) {
          frag += `a=${candidate.candidate}\r\n`
        }
      }
      mid++
    }

    return frag
  }

  /**
   * Handle errors.
   */
  private handleError(err: Error | WebRTCError): void {
    this.stopFlowCheck()

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
      ].map(c => WebRTCWhep.supportsNonAdvertisedCodec(c[0], c[1]).then(r => (r ? c[0] : false))),
    )
      .then(c => c.filter(e => e !== false))
      .then((codecs) => {
        if (this.state !== 'getting_codecs') {
          throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')
        }

        this.nonAdvertisedCodecs = codecs
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
    }).then(res => WebRTCWhep.linkToIceServers(res.headers.get('Link')))
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

      offer.sdp = WebRTCWhep.editOffer(offer.sdp, this.nonAdvertisedCodecs)
      this.offerData = WebRTCWhep.parseOffer(offer.sdp)

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
      body: WebRTCWhep.generateSdpFragment(this.offerData, candidates),
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
      this.startFlowCheck()
    }
  }

  /**
   * 启动断流检测
   */
  private startFlowCheck(): void {
    this.stopFlowCheck()
    this.checkTimer = setInterval(() => this.checkFlowState(), this.checkInterval)
  }

  /**
   * 停止断流检测
   */
  private stopFlowCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = undefined
    }
  }

  /*
   * 检测流状态（通过接收字节数判断是否断流）
   */
  private async checkFlowState(): Promise<void> {
    if (!this.pc) {
      return
    }

    const stats = await this.pc.getStats()
    let currentBytes = 0

    // 遍历统计信息，获取视频接收字节数
    stats.forEach((stat: RTCStats) => {
      const inboundRtpStat = stat as RTCInboundRtpStreamStats
      if (stat.type === 'inbound-rtp' && inboundRtpStat.kind === 'video') {
        currentBytes = inboundRtpStat.bytesReceived || 0
      }
    })

    // 断流判定：连接正常但字节数无变化
    if (currentBytes === this.lastBytesReceived && this.pc.connectionState === 'connected') {
      this.handleError(new WebRTCError(ErrorTypes.NETWORK_ERROR, 'data stream interruption'))
      return
    }

    // 更新上一次字节数
    this.lastBytesReceived = currentBytes
  }

  /**
   * Handle incoming tracks.
   */
  private onTrack(evt: RTCTrackEvent): void {
    this.stream = evt.streams[0]
    this.observer.start(this.container, (isIntersecting) => {
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
    return this.container.srcObject === null
  }

  /**
   * 暂停播放
   */
  pause() {
    this.container.srcObject = null
  }

  /**
   * 恢复播放
   */
  resume() {
    if (this.stream && this.paused)
      this.container.srcObject = this.stream
  }
}
