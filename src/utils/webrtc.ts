import { ErrorTypes, WebRTCError } from '~/errors'
import { SdpUtils } from './sdp'

/**
 * WebRTC utilities
 */
export class WebRtcUtils {
  /**
   * Check if the browser supports a non-advertised codec.
   */
  static async supportsNonAdvertisedCodec(codec: string, fmtp: string | undefined, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false)
        return
      }

      const pc = new RTCPeerConnection({ iceServers: [] })
      let settled = false
      const finish = (result: boolean | Event): void => {
        if (settled)
          return
        settled = true
        signal.removeEventListener('abort', finish)
        pc.close()
        resolve(result === true)
      }
      signal.addEventListener('abort', finish, { once: true })
      // 自动检测媒体类型：video 开头为视频，其他为音频
      const mediaType = codec.startsWith('video/') ? 'video' : 'audio'
      const encoding = mediaType === 'video' ? `${codec.slice('video/'.length)}/90000` : codec
      let payloadType = ''
      let mid: string | undefined
      let setup = 'active'

      Promise.resolve().then(() => {
        signal.throwIfAborted()
        pc.addTransceiver(mediaType, { direction: 'recvonly' })
        return pc.createOffer()
      }).then((offer) => {
        signal.throwIfAborted()
        if (!offer.sdp) {
          throw new Error('SDP not present')
        }
        if (offer.sdp.includes(` ${encoding}`)) {
          // codec is advertised, there's no need to add it manually
          throw new Error('already present')
        }

        const sections = offer.sdp.split(`m=${mediaType}`)

        const payloadTypes = sections
          .slice(1)
          .map(s => s.split('\r\n')[0].split(' ').slice(3))
          .reduce((prev, cur) => [...prev, ...cur], [])
        payloadType = SdpUtils.reservePayloadType(payloadTypes)

        const lines = sections[1].split('\r\n')
        mid = lines.find(line => line.startsWith('a=mid:'))
        if (lines.includes('a=setup:active') || (!lines.some(line => line.startsWith('a=setup:')) && sections[0].split('\r\n').includes('a=setup:active')))
          setup = 'passive'
        lines[0] += ` ${payloadType}`
        lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} ${encoding}`)
        if (fmtp !== undefined) {
          lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} ${fmtp}`)
        }
        sections[1] = lines.join('\r\n')
        offer.sdp = sections.join(`m=${mediaType}`)
        return pc.setLocalDescription(offer)
      }).then(() => {
        signal.throwIfAborted()
        return pc.setRemoteDescription(
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
                + `a=sendonly\r\n${
                  mid ? `${mid}\r\n` : ''
                }a=setup:${setup}\r\n`
                + `a=rtcp-mux\r\n`
                + `a=rtpmap:${payloadType} ${encoding}\r\n${fmtp !== undefined ? `a=fmtp:${payloadType} ${fmtp}\r\n` : ''}`,
          }),
        )
      }).then(() => finish(true), () => finish(false))
    })
  }

  /** Read only ICE server links, preserving quoted delimiters in parameters. */
  static linkToIceServers(links: string | null): RTCIceServer[] {
    const servers: RTCIceServer[] = []
    const linkPattern = /(?:^|,)\s*<([^>]*)>((?:[^,\x22]|"(?:[^"\\]|\\.)*")*)/g
    const parameterPattern = /;\s*([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g
    for (const [, url, parameters] of (links ?? '').matchAll(linkPattern)) {
      const fields = new Map<string, string>()
      for (const [, key, quoted, token] of parameters.matchAll(parameterPattern)) {
        const name = key.toLowerCase()
        if (!fields.has(name))
          fields.set(name, quoted === undefined ? token : quoted.replace(/\\(.)/g, '$1'))
      }
      if (!fields.get('rel')?.toLowerCase().split(/\s+/).includes('ice-server'))
        continue
      if (!/^(?:stun|stuns|turn|turns):\S+$/i.test(url))
        throw new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Invalid ICE server URL')

      const server: RTCIceServer = { urls: [url] }
      const username = fields.get('username')
      const credential = fields.get('credential')
      if (username !== undefined && credential !== undefined && (fields.get('credential-type') ?? 'password') === 'password') {
        server.username = username
        server.credential = credential
        server.credentialType = 'password'
      }
      servers.push(server)
    }
    return servers
  }
}
