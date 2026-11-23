import { WebRtcUtils } from '../utils/webrtc'

export class CodecDetector {
  private readonly controller = new AbortController()

  constructor(private readonly timeoutMs: number) {}

  async detect(): Promise<string[]> {
    const { signal } = this.controller
    const timeout = setTimeout(() => this.stop(), this.timeoutMs)
    try {
      const results = await Promise.all(
        [
          // 音频编解码器
          ['pcma/8000/2'],
          ['multiopus/48000/6', 'channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2'],
          ['L16/48000/2'],
          // 视频编解码器
          ['video/H265'],
          ['video/VP9'],
          ['video/AV1'],
        ].map((c) =>
          WebRtcUtils.supportsNonAdvertisedCodec(c[0], c[1], signal).then(
            (r) => (r ? c[0] : false),
            () => false,
          ),
        ),
      )
      return signal.aborted ? [] : results.filter((codec): codec is string => codec !== false)
    } finally {
      clearTimeout(timeout)
    }
  }

  stop(): void {
    this.controller.abort()
  }
}
