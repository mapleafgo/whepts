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

- `src/index.ts` - Exports the main `WebRTCWhep` class and public types (including `WhepEvents`)

### Core Components (`src/core/`)

All core modules use EventEmitter for communication:

- **`connection.ts`** (`ConnectionManager`) - Manages RTCPeerConnection lifecycle, handles ICE candidates, connection state monitoring, and ICE restart on failure. Emits: `candidate`, `track`, `error`

- **`http.ts`** (`HttpClient`) - HTTP client for WHEP protocol: OPTIONS (ICE servers), POST (send offer), PATCH (send candidates). Supports Basic and Bearer token auth. Emits: `error`

- **`track.ts`** (`TrackManager`) - Manages media tracks, uses IntersectionObserver to auto-pause/resume when video goes off-screen (threshold: 50%)

- **`codec.ts`** (`CodecDetector`) - Detects browser support for non-advertised codecs (pcma/8000/2, multiopus/48000/6, L16/48000/2) at startup. Emits: `codecs:detected`, `error`

### Utilities (`src/utils/`)

- **`sdp.ts`** (`SdpUtils`) - SDP manipulation: parsing offers, reserving payload types (30-127, excluding 64-95), enabling stereo/multichannel codecs, generating SDP fragments for trickle-ice

- **`webrtc.ts`** (`WebRtcUtils`) - WebRTC utilities: codec support detection, parsing Link headers to ICE servers

- **`flow-check.ts`** (`FlowCheck`) - Monitors stream health by checking if bytes received are stagnating while connection is "connected". Uses adaptive polling: high-frequency checks (default: 5s) during initial stabilization period (default: 30s), then switches to lower frequency (default: 10s) to reduce overhead. Requires consecutive no-progress periods (default: 3) before triggering error to avoid false positives. Automatically cleans up resources when closed. Emits: `error`

### State Management (with nanostores)

WebRTCWhep uses nanostores for reactive state management:

- **State Store**: `atom<State>` managed reactively
- **State Changes**: Automatically emit `state:change` events on transitions
- **Available States**:
  - `getting_codecs` - Initial state during codec detection
  - `running` - Normal operation
  - `restarting` - Recovering from errors, will retry after 2s
  - `closed` - Explicitly closed
  - `failed` - Permanent failure (signal errors, 404/406, bad requests)

### Event System

**Public Events** (defined in `WhepEvents` interface):
- `state:change` - State transitions, payload: `{ from: State, to: State }`
- `candidate` - ICE candidates
- `track` - Media tracks
- `error` - Errors
- `close` - Connection closed
- `restart` - Reconnection starting

**Internal Events**:
- `codecs:detected` - Codec detection complete (handled internally)

### Error Handling

All errors go through `WebRTCWhep.handleError()` and are emitted via the `error` event:

- Signal/NotFound/Request errors → `failed` state
- Errors while `running` → cleanup session, `restarting` state, retry after 2s
- All errors emitted via `error` event for users to handle

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
