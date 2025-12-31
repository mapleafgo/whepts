import { ErrorTypes, WebRTCError } from './errors'

/**
 * WebRTC utilities
 */
export class WebRtcUtils {
  /**
   * Check if the browser supports a non-advertised codec.
   */
  static async supportsNonAdvertisedCodec(codec: string, fmtp?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const pc = new RTCPeerConnection({ iceServers: [] })
      const mediaType = 'audio'
      let payloadType = ''

      pc.addTransceiver(mediaType, { direction: 'recvonly' })
      pc.createOffer()
        .then((offer) => {
          if (!offer.sdp) {
            throw new Error('SDP not present')
          }
          if (offer.sdp.includes(` ${codec}`)) {
            // codec is advertised, there's no need to add it manually
            throw new Error('already present')
          }

          const sections = offer.sdp.split(`m=${mediaType}`)

          const payloadTypes = sections
            .slice(1)
            .map(s => s.split('\r\n')[0].split(' ').slice(3))
            .reduce((prev, cur) => [...prev, ...cur], [])
          payloadType = WebRtcUtils.reservePayloadType(payloadTypes)

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
  static unquoteCredential(v: string): string {
    return JSON.parse(`"${v}"`)
  }

  /**
   * Convert Link header to iceServers array.
   */
  static linkToIceServers(links: string | null): RTCIceServer[] {
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
          ret.username = WebRtcUtils.unquoteCredential(m[3])
          ret.credential = WebRtcUtils.unquoteCredential(m[4])
          ret.credentialType = 'password'
        }

        return ret
      })
    }
    return []
  }

  /**
   * Reserve a payload type.
   */
  static reservePayloadType(payloadTypes: string[]): string {
    // everything is valid between 30 and 127, except for interval between 64 and 95
    // https://chromium.googlesource.com/external/webrtc/+/refs/heads/master/call/payload_type.h#29
    for (let i = 30; i <= 127; i++) {
      if ((i <= 63 || i >= 96) && !payloadTypes.includes(i.toString())) {
        const pl = i.toString()
        payloadTypes.push(pl)
        return pl
      }
    }
    throw new Error('unable to find a free payload type')
  }
}