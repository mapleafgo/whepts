import type { WebRTCError } from './errors'

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
  /** Enable lazy loading (auto pause/resume when video goes off-screen). Default: true */
  lazyLoad?: boolean
}

/**
 * Event types emitted by WebRTCWhep
 */
export interface WhepEvents {
  'codecs:detected': (codecs: string[]) => void
  'state:change': (payload: { from: State, to: State }) => void
  'candidate': (candidate: RTCIceCandidate) => void
  'track': (evt: RTCTrackEvent) => void
  'error': (err: WebRTCError) => void
  'close': () => void
  'restart': () => void
}

/**
 * State type for WebRTCWhep.
 */
export type State = 'getting_codecs' | 'running' | 'restarting' | 'closed' | 'failed'

/** Extend RTCConfiguration to include experimental properties */
declare global {
  interface RTCConfiguration {
    sdpSemantics?: 'plan-b' | 'unified-plan'
  }

  interface RTCIceServer {
    credentialType?: 'password'
  }
}
