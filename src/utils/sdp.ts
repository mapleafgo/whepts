/** Type for parsed offer data */
export interface ParsedOffer {
  iceUfrag: string
  icePwd: string
  medias: string[]
}

/**
 * SDP processing utilities
 */
export class SdpUtils {
  /**
   * Parse an offer SDP into iceUfrag, icePwd, and medias.
   */
  static parseOffer(sdp: string): ParsedOffer {
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

  /**
   * Enable stereo PCMA/PCMU codecs.
   */
  static enableStereoPcmau(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    let payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} PCMU/8000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} PCMA/8000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    return lines.join('\r\n')
  }

  /**
   * Enable multichannel Opus codec.
   */
  static enableMultichannelOpus(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    let payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/3`)
    lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} channel_mapping=0,2,1;num_streams=2;coupled_streams=1`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/4`)
    lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} channel_mapping=0,1,2,3;num_streams=2;coupled_streams=2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/5`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,4,1,2,3;num_streams=3;coupled_streams=2`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/6`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/7`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,4,1,2,3,5,6;num_streams=4;coupled_streams=4`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
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
  static enableL16(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    let payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} L16/8000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} L16/16000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} L16/48000/2`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    return lines.join('\r\n')
  }

  /**
   * Enable stereo Opus codec.
   */
  static enableStereoOpus(section: string): string {
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
  static editOffer(sdp: string, nonAdvertisedCodecs: string[]): string {
    const sections = sdp.split('m=')

    const payloadTypes = sections
      .slice(1)
      .map(s => s.split('\r\n')[0].split(' ').slice(3))
      .reduce((prev, cur) => [...prev, ...cur], [])

    for (let i = 1; i < sections.length; i++) {
      if (sections[i].startsWith('audio')) {
        sections[i] = SdpUtils.enableStereoOpus(sections[i])

        if (nonAdvertisedCodecs.includes('pcma/8000/2')) {
          sections[i] = SdpUtils.enableStereoPcmau(payloadTypes, sections[i])
        }
        if (nonAdvertisedCodecs.includes('multiopus/48000/6')) {
          sections[i] = SdpUtils.enableMultichannelOpus(payloadTypes, sections[i])
        }
        if (nonAdvertisedCodecs.includes('L16/48000/2')) {
          sections[i] = SdpUtils.enableL16(payloadTypes, sections[i])
        }

        break
      }
    }

    return sections.join('m=')
  }

  /**
   * Generate an SDP fragment.
   */
  static generateSdpFragment(od: ParsedOffer, candidates: RTCIceCandidate[]): string {
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
}
