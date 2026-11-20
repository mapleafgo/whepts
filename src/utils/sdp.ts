interface IceAttributes {
  iceUfrag?: string
  icePwd?: string
}

interface MediaSection extends IceAttributes {
  description: string
  mid?: string
}

export interface ParsedOffer extends IceAttributes {
  media: MediaSection[]
}

/**
 * SDP processing utilities
 */
export class SdpUtils {
  /** Parse the media identifiers and ICE attributes at their SDP scope. */
  static parseOffer(sdp: string): ParsedOffer {
    const offer: ParsedOffer = { media: [] }
    let section: MediaSection | undefined
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith('m=')) {
        section = { description: line.slice(2) }
        offer.media.push(section)
      }
      else if (line.startsWith('a=ice-ufrag:')) {
        (section ?? offer).iceUfrag = line.slice('a=ice-ufrag:'.length)
      }
      else if (line.startsWith('a=ice-pwd:')) {
        (section ?? offer).icePwd = line.slice('a=ice-pwd:'.length)
      }
      else if (section && line.startsWith('a=mid:')) {
        section.mid = line.slice('a=mid:'.length)
      }
    }
    return offer
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

    // 6.1 和 7.1 使用 libopus 的 Vorbis 声道映射。
    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/7`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,4,1,2,3,5,6;num_streams=4;coupled_streams=3`,
    )
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)

    payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} multiopus/48000/8`)
    lines.splice(
      lines.length - 1,
      0,
      `a=fmtp:${payloadType} channel_mapping=0,6,1,2,3,4,5,7;num_streams=5;coupled_streams=3`,
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
   * Enable H265 codec.
   */
  static enableH265(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    const payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} H265/90000`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)
    lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} profile-id=1`)

    return lines.join('\r\n')
  }

  /**
   * Enable VP9 codec.
   */
  static enableVP9(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    const payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} VP9/90000`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)
    lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} profile-id=0`)

    return lines.join('\r\n')
  }

  /**
   * Enable AV1 codec.
   */
  static enableAV1(payloadTypes: string[], section: string): string {
    const lines = section.split('\r\n')

    const payloadType = SdpUtils.reservePayloadType(payloadTypes)
    lines[0] += ` ${payloadType}`
    lines.splice(lines.length - 1, 0, `a=rtpmap:${payloadType} AV1/90000`)
    lines.splice(lines.length - 1, 0, `a=rtcp-fb:${payloadType} transport-cc`)
    lines.splice(lines.length - 1, 0, `a=fmtp:${payloadType} profile-id=0`)

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
      // 处理音频编解码器
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
      }

      // 处理视频编解码器
      if (sections[i].startsWith('video')) {
        if (nonAdvertisedCodecs.includes('video/H265') || nonAdvertisedCodecs.includes('video/hevc')) {
          sections[i] = SdpUtils.enableH265(payloadTypes, sections[i])
        }
        if (nonAdvertisedCodecs.includes('video/VP9') || nonAdvertisedCodecs.includes('video/vp9')) {
          sections[i] = SdpUtils.enableVP9(payloadTypes, sections[i])
        }
        if (nonAdvertisedCodecs.includes('video/AV1') || nonAdvertisedCodecs.includes('video/av1')) {
          sections[i] = SdpUtils.enableAV1(payloadTypes, sections[i])
        }
      }
    }

    return sections.join('m=')
  }

  /** Serialize candidates and per-media end markers against the original offer. */
  static generateSdpFragment(offer: ParsedOffer, candidates: RTCIceCandidate[]): string {
    const bySection = new Map<MediaSection, string[]>()
    for (const candidate of candidates) {
      const { sdpMid, sdpMLineIndex } = candidate
      const media = sdpMid != null
        ? offer.media.find(section => section.mid === sdpMid)
        : sdpMLineIndex == null ? undefined : offer.media[sdpMLineIndex]
      if (!media?.mid)
        continue

      const line = candidate.candidate ? `a=${candidate.candidate}` : 'a=end-of-candidates'
      const lines = bySection.get(media)
      if (lines)
        lines.push(line)
      else
        bySection.set(media, [line])
    }

    if (bySection.size === 0)
      return ''

    const fragment: string[] = []
    SdpUtils.appendIceAttributes(fragment, offer)
    for (const [media, lines] of bySection) {
      fragment.push(`m=${media.description}`, `a=mid:${media.mid}`)
      SdpUtils.appendIceAttributes(fragment, media)
      fragment.push(...lines)
    }
    return `${fragment.join('\r\n')}\r\n`
  }

  private static appendIceAttributes(lines: string[], attributes: IceAttributes): void {
    if (attributes.iceUfrag)
      lines.push(`a=ice-ufrag:${attributes.iceUfrag}`)
    if (attributes.icePwd)
      lines.push(`a=ice-pwd:${attributes.icePwd}`)
  }
}
