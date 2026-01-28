# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Whepts is a WebRTC WHEP (WebRTC-HTTP Egress Protocol) player library that supports streaming from MediaMTX and ZLMediaKit servers. It's a browser-based TypeScript library built with an event-driven architecture.

## Common Commands

### Build

- `pnpm build` - Production build with minification
- `pnpm build:debug` - Debug build with source maps

### Linting

- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Run ESLint with auto-fix

## Architecture

The library follows an **event-driven architecture** with modular components:

### Core Design

- **Event-Driven Communication**: All modules communicate via EventEmitter events
- **Reactive State Management**: State managed reactively with nanostores
- **Central Event Bus**: WebRTCWhep extends EventEmitter as the central event hub

### Entry Point

- `src/index.ts` - Exports the main `WebRTCWhep` class and public types (including `WhepEvents`, `Conf`, `State`, `ErrorTypes`, `WebRTCError`)

### Type Definitions

- `src/types.ts` - Public type definitions:
  - `Conf` - Configuration interface with all options
  - `State` - State type union (5 states)
  - `WhepEvents` - Event interface for all public events
  - Global type extensions for `RTCConfiguration` and `RTCIceServer`

### Core Components (`src/core/`)

All core modules use EventEmitter for communication:

- **`connection.ts`** (`ConnectionManager`) - Manages RTCPeerConnection lifecycle, handles ICE candidates, connection state monitoring, and ICE restart on failure. Emits: `candidate`, `track`, `error`

- **`http.ts`** (`HttpClient`) - HTTP client for WHEP protocol: OPTIONS (ICE servers), POST (send offer), PATCH (send candidates). Supports Basic and Bearer token auth. Emits: `error`

- **`track.ts`** (`TrackManager`) - Manages media tracks and video element lifecycle. Validates streams contain video tracks (rejects audio-only streams), uses IntersectionObserver to auto-pause/resume when video goes off-screen (threshold: 50%). Provides `stop()` (preserves listeners) and `destroy()` (permanent cleanup) methods

- **`codec.ts`** (`CodecDetector`) - Detects browser support for non-advertised codecs at startup. Supports audio codecs (pcma/8000/2, multiopus/48000/6, L16/48000/2) and video codecs (H265/HEVC, VP9, AV1). Emits: `codecs:detected`, `error`

### Utilities (`src/utils/`)

- **`sdp.ts`** (`SdpUtils`) - SDP manipulation: parsing offers, reserving payload types (30-127, excluding 64-95), enabling stereo/multichannel audio codecs, enabling video codecs (H265, VP9, AV1), generating SDP fragments for trickle-ice

- **`webrtc.ts`** (`WebRtcUtils`) - WebRTC utilities: codec support detection (auto-detects media type: audio or video), parsing Link headers to ICE servers

### Monitoring (`src/monitors/`)

- **`scheduler.ts`** (`MonitorScheduler`) - Centralized scheduler for managing monitoring tasks. Each player instance has its own scheduler (not singleton). Provides task deduplication, adaptive throttling, and priority-based execution.

- **`play-monitor.ts`** (`PlayMonitor`) - Monitors video element playback state. Detects playback stalls and video element crashes, with automatic recovery mechanism (max 3 attempts with 1s delay). Emits: `play:stalled`

- **`flow-monitor.ts`** (`FlowMonitor`) - Monitors WebRTC stream flow health. Checks if bytes received are stagnating while connection is "connected". Uses adaptive polling: high-frequency checks (5000ms interval) during initial stabilization (30000ms), then switches to lower frequency (10000ms). Emits: `flow:stalled`

### State Management (with nanostores)

WebRTCWhep uses nanostores for reactive state management:

- **State Store**: `atom<State>` managed reactively
- **State Changes**: Automatically emit `state:change` events on transitions
- **Available States**:
  - `getting_codecs` - Initial state during codec detection
  - `running` - Normal operation
  - `restarting` - Recovering from errors, will retry after 2s
  - `closed` - Explicitly closed (via `close()` method)
  - `failed` - Permanent failure (signal errors, 404/406, bad requests)

### Event System

**Public Events** (defined in `WhepEvents` interface):
- `codecs:detected` - Non-advertised codecs detected, payload: `string[]` (audio codecs: 'pcma/8000/2', 'multiopus/48000/6', 'L16/48000/2'; video codecs: 'video/H265', 'video/VP9', 'video/AV1')
- `state:change` - State transitions, payload: `{ from: State, to: State }`
- `candidate` - ICE candidates
- `track` - Media tracks
- `error` - Errors
- `close` - Connection closed
- `restart` - Reconnection starting
- `play:stalled` - Playback stalled, payload: `{ reason: string }`
- `flow:stalled` - Stream flow stalled, payload: `{ reason: string }`

**Internal Events**:
- None (all events are public, `codecs:detected` is both public and handled internally to start connection)

**Event Message Language Convention**:
- Event payloads (`reason`, error messages, etc.) MUST be in English for API consistency
- Code comments and documentation SHOULD be in Chinese for maintainability
- Example: `emit('flow:stalled', { reason: 'Stream interrupted: video flow stalled' })` with Chinese comment `// 触发断流停滞事件`

### Error Handling

All errors go through `WebRTCWhep.handleError()` and are emitted via the `error` event:

**Error Types** (defined in `ErrorTypes`):
- `SIGNAL_ERROR` - Signaling errors
- `NOT_FOUND_ERROR` - Resource not found (404)
- `REQUEST_ERROR` - Bad requests (400, 406)
- `NETWORK_ERROR` - Network-related errors
- `MEDIA_ERROR` - Media-related errors
- `OTHER_ERROR` - Other errors

**Error State Transitions**:
- Signal/NotFound/Request errors → `failed` state
- Network/Media/Other errors while `running` → cleanup session, `restarting` state, retry after 2s
- All errors emitted via `error` event for users to handle

### Public API Methods

- **`close()`** - Terminates the connection and releases all resources. Sets state to `closed` (final state)
- **`pause()`** / **`resume()`** - Pauses/resumes media playback without closing connection
- **`updateUrl(url: string)`** - Updates the WHEP endpoint URL and restarts playback:
  - Clears any pending restart timeouts
  - Cleans up the existing session (DELETE request to server)
  - Resets state to `running` and starts connection with new URL
  - Emits error if called when state is `closed`
  - Useful for fallback/failover scenarios when current URL fails

### Private Helper Methods

- **`cleanupSession()`** - Centralized session cleanup logic (reused by `handleError()` and `updateUrl()`):
  - Closes the RTCPeerConnection
  - Closes flow monitoring
  - Clears queued ICE candidates
  - Sends DELETE request to server to terminate session
  - Clears the stored session URL

### WebRTC Specifics

- Always use `unified-plan` SDP semantics
- Handle ICE candidates with queuing when session URL not ready
- Support non-advertised codecs:
  - Audio: `pcma/8000/2` (G.711 A-law), `multiopus/48000/6` (6-channel Opus), `L16/48000/2` (Linear PCM)
  - Video: `video/H265` (HEVC), `video/VP9`, `video/AV1`
- Codec detection happens automatically at startup, emits `codecs:detected` event
- Video stream validation: automatically rejects audio-only streams with `OTHER_ERROR`
- Video element crash recovery: automatic recovery with max 3 attempts, 1 second delay between attempts
- Use `IntersectionObserver` for visibility-based playback control (threshold: 50%)
- FlowCheck monitors `RTCInboundRtpStreamStats.bytesReceived` for stream health

### Resource Management Lifecycle

- **`stop()`** - Temporarily stop monitoring while preserving event listeners (used during restart)
- **`destroy()`** - Permanently destroy monitors and remove all event listeners (only called by `close()`)
- **`close()`** - Final cleanup: calls `destroy()` on monitors, destroys scheduler, releases all resources

### Dependencies

Runtime dependencies:
- **eventemitter3** - Event emitter for Node.js and the browser
- **nanostores** - Small (1 KB) state manager with many internals

## TypeScript Configuration

- ES2020 target with DOM and ESNext libs
- Path alias: `~/*` maps to `src/*`
- Strict mode enabled with strict null checks
- Output: ESM format with `dist/` directory

## Build Configuration

- Rollup with TypeScript, ESLint, Terser plugins
- Production builds drop console/debugger statements
- External dependencies: none (pure browser library)
- Entry point: `src/index.ts` → `dist/index.js`

## Code Style

- Uses @antfu/eslint-config with `type: 'lib'`
- pnpm as package manager
- TypeScript path resolution enabled
- No formatting of markdown files
