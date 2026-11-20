import type { EventEmitter } from 'eventemitter3'
import type { WebRTCError } from './errors.js'

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
  /** Send candidates incrementally, or wait and include them in the offer. Default: trickle. */
  iceMode?: 'trickle' | 'complete'
  /** Enable lazy loading (auto pause/resume when video goes off-screen). Default: true */
  lazyLoad?: boolean
  /** Observe sanitized operational failures without changing player state. */
  onDiagnostic?: (diagnostic: WhepDiagnostic) => void
}

/** Best-effort diagnostics for operations outside the playback error path. */
export interface WhepDiagnostic {
  playerId: number
  attemptId?: number
  state: State
  operation: 'delete-session' | 'sample-flow'
  phase: 'signaling' | 'connection'
  elapsedMs: number
  reason: 'http-error' | 'timeout' | 'request-failed'
  httpStatus?: number
}

/**
 * Event types emitted by WebRTCWhep
 */
export interface WhepEvents {
  'codecs:detected': (codecs: string[]) => void
  'state:change': (payload: { from: State, to: State }) => void
  'candidate': (candidate: RTCIceCandidate) => void
  'track': (evt: RTCTrackEvent) => void
  'play:success': (payload: { muted: boolean }) => void
  'play:failed': (payload: { code: 'autoplay-blocked' | 'video-unavailable' | 'element-recovery-exhausted' | 'playback-error', reason: string, muted: boolean }) => void
  'play:stalled': (payload: { reason: string }) => void
  'flow:stalled': (payload: { reason: string }) => void
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

type MediaEvent = 'play:failed' | 'play:success' | 'play:stalled' | 'flow:stalled'

export type MediaNotifier = <K extends MediaEvent>(event: K, ...args: EventEmitter.EventArgs<WhepEvents, K>) => void
