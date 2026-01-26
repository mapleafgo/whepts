import type EventEmitter from 'eventemitter3'
import type { State } from '~/types'
import { ErrorTypes, WebRTCError } from '~/errors'
import { WebRtcUtils } from '../utils/webrtc'

export interface CodecDetectorOptions {
  getState: () => State
  emitter: EventEmitter
}

export class CodecDetector {
  constructor(private options: CodecDetectorOptions) {}

  detect(): void {
    Promise.all(
      [
        ['pcma/8000/2'],
        ['multiopus/48000/6', 'channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2'],
        ['L16/48000/2'],
      ].map(c => WebRtcUtils.supportsNonAdvertisedCodec(c[0], c[1]).then(r => (r ? c[0] : false))),
    )
      .then(c => c.filter(e => e !== false))
      .then((codecs) => {
        if (this.options.getState() !== 'getting_codecs')
          throw new WebRTCError(ErrorTypes.STATE_ERROR, 'closed')

        this.options.emitter.emit('codecs:detected', codecs as string[])
      })
      .catch(err => this.options.emitter.emit('error', err))
  }
}
