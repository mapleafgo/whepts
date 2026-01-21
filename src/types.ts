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
  /** Called when there's an error */
  onError?: (err: WebRTCError) => void
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
