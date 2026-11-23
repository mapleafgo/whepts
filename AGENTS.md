# AGENTS.md - WhepTS Player

## Build/Lint Commands

- `npm run build` - Production build with minification
- `npm run build:debug` - Debug build with source maps
- `npm run lint` - Run oxlint to check code quality
- `npm run lint:fix` - Auto-fix oxlint issues
- `npm run format` - Format with oxfmt
- `npm run format:check` - Verify formatting without writing

- `npm test` - Build the production bundle and run the Node regression suite
- `node_modules/.bin/tsc --noEmit` - Type-check without emitting

回归用例位于 `tests/lifecycle.test.mjs`，浏览器夹具见 `tests/browser-*.py` 与 `tests/package-smoke.sh`。

## Code Style Guidelines

### Imports

- Use `~/` alias for imports from `src/` (e.g., `import X from '~/utils/observer'`)
- Import types explicitly using `import type { T } from './module'`
- Group external dependencies first, then internal imports

### Formatting

- Formatting is handled by oxfmt with its default options; linting by oxlint with its default rules
- Run `npm run format` and `npm run lint:fix` before committing
- No manual formatting required - let the tools handle it

### Types

- Strict mode enabled in `tsconfig.json`
- Use `interface` for object shapes, `type` for unions/aliases
- Mark optional properties with `?` (e.g., `onError?: (err: WebRTCError) => void`)
- Use TypeScript strictly - no `any` types

### Naming Conventions

- **Classes**: PascalCase (e.g., `WebRTCWhep`, `VisibilityObserver`)
- **Interfaces**: PascalCase (e.g., `Conf`, `ErrorType`)
- **Functions/Methods**: camelCase (e.g., `setupPeerConnection`, `handleError`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `ErrorTypes`)
- **Private members**: prefix with `private` keyword

### Error Handling

- Use custom `WebRTCError` class for all errors (defined in `src/errors.ts`)
- Error types: `SIGNAL_ERROR`, `STATE_ERROR`, `REQUEST_ERROR`, `NOT_FOUND_ERROR`, `VIDEO_ERROR`, `OTHER_ERROR`
- HTTP failures use `REQUEST_ERROR` and expose the code through `httpStatus`; never map statuses to specific causes
- Pattern: `throw new WebRTCError(ErrorTypes.REQUEST_ERROR, 'Unexpected WHEP response status', { phase: 'signaling', httpStatus })`
- Route player-level failures through `failSetup()` / `notifyError()` so state and diagnostics stay consistent

### Comments

- Use JSDoc for public APIs and class constructors (in English)
- Keep implementation comments concise in Chinese as established
- Example:

  ```typescript
  /**
   * Create a WebRTCWhep.
   * @param {Conf} conf - Configuration.
   */
  constructor(conf: Conf)
  ```

### Event Message Language Convention

**Critical Rule**: All event payload messages MUST be in English, code comments in Chinese

- **Event payloads** (e.g., `reason`, error messages) → English only
  - ✅ `emit('flow:stalled', { reason: 'Stream interrupted: video flow stalled' })`
  - ❌ `emit('flow:stalled', { reason: '数据流中断：检测到视频流已停滞' })`

- **Code comments** → Chinese for maintainability
  - ✅ `// 触发断流停滞事件`
  - ❌ `// Trigger stream stall event`

**Rationale**:
- API consistency: English messages are standard for public APIs
- Debugging: English messages are easier to search and log internationally
- Maintainability: Chinese comments help local team understand code quickly

**Examples**:
```typescript
// ❌ Wrong: Chinese in event payload
this.emitter.emit('play:stalled', {
  reason: '播放验证失败：媒体已暂停',  // Don't do this!
})

// ✅ Correct: English in event payload, Chinese in comments
// 播放停滞：媒体已暂停
this.emitter.emit('play:stalled', {
  reason: 'Playback verification failed: media is paused',
})
```

### File Organization

- Core logic in `src/` directory
- Core modules in `src/core/` (e.g., `connection.ts`, `http.ts`, `track.ts`, `codec.ts`)
- Utilities in `src/utils/` (e.g., `sdp.ts`, `webrtc.ts`)
- Monitoring in `src/monitors/` (e.g., `scheduler.ts`, `play-monitor.ts`, `flow-monitor.ts`)
- Type definitions in `src/types.ts` (public API types)
- Error types in `src/errors.ts`
- Main class implementation in `src/whep.ts`
- Export main class and types from `src/index.ts`

### State Management

- Use union literal types for state (e.g., `'getting_codecs' | 'running' | 'restarting' | 'closed' | 'failed'`)
- Always check state before operations that depend on it
- Use getters for derived properties (e.g., `get isRunning()`)
- `closed` is a final state - once entered, no further operations (except cleanup) are allowed
- Always create private helper methods to reuse common cleanup logic (e.g., `cleanupSession()`)

### Public API Design

- Public methods should have JSDoc comments with usage examples
- Configuration options should have JSDoc comments in `src/types.ts`
- When adding new public methods, consider:
  - State validation (reject operations in terminal states like `closed`)
  - Resource cleanup (reuse existing cleanup helpers)
  - State transitions (ensure proper state changes)
  - Event emission (keep users informed)
- Example: `updateUrl()` validates `closed` state, reuses `cleanupSession()`, and restarts playback

**Current Configuration Options** (from `Conf` interface):
- `url`: WHEP endpoint URL (required)
- `container`: HTML media element (required)
- `user`: Basic auth username (optional)
- `pass`: Basic auth password (optional)
- `token`: Bearer token (optional)
- `iceServers`: Custom ICE servers (optional)
- `iceMode`: `'trickle'` (default) or `'complete'` (optional)
- `lazyLoad`: Enable auto pause/resume when off-screen (optional, default: true)
- `onDiagnostic`: Optional callback for sanitized `delete-session` and `sample-flow` diagnostics

### WebRTC Specifics

- Always use `unified-plan` SDP semantics
- Handle ICE candidates with queuing when session URL not ready
- Support non-advertised codecs:
  - Audio: `pcma/8000/2` (G.711 A-law), `multiopus/48000/6` (6-channel Opus), `L16/48000/2` (Linear PCM)
  - Video: `video/H265` (HEVC), `video/VP9`, `video/AV1`
- Codec detection happens automatically at startup, emits `codecs:detected` event
- Video stream validation: automatically reject audio-only streams with `OTHER_ERROR`
- Video element crash recovery: automatic recovery with max 3 attempts, 1 second delay between attempts
- Use `IntersectionObserver` for visibility-based playback control (threshold: 50%)
- FlowCheck monitors `RTCInboundRtpStreamStats.bytesReceived` for stream health

### Resource Management Lifecycle

- **`stop()`** - Temporarily stop monitoring while preserving event listeners (used during restart)
- **`destroy()`** - Permanently destroy monitors and remove all event listeners (only called by `close()`)
- **`close()`** - Final cleanup: calls `destroy()` on monitors, destroys scheduler, releases all resources

### Monitoring Architecture

- Each player instance has its own `MonitorScheduler` (not singleton)
- Monitors use scheduler to register tasks with type names (not unique IDs)
- Task deduplication prevents duplicate monitor types
- Adaptive throttling reduces overhead when multiple players are active
- `PlayMonitor` handles video element playback and crash recovery
- `FlowMonitor` handles stream flow health monitoring

### Debug Logging

- Production build strips all console output (`rollup.config.ts`); do not rely on logs for user-facing diagnosis
- `npm run build:debug` keeps source maps and logging; `state:change` uses `console.debug` and requires Verbose in DevTools
- `console.warn` reports player errors and diagnostics; never log credentials, session URLs, SDP, ICE credentials or candidates
- Debug bundles prefix logs with `[WhepTS]`; keep new diagnostics on the same public `onDiagnostic` contract

## Tech Stack

- TypeScript 5.9 with strict mode
- Rollup for bundling (ES module output)
- oxlint for linting and oxfmt for formatting
- pnpm as package manager

## Before Committing

1. Run `npm run lint` and fix all issues
2. Build with `npm run build` to verify production build works
3. Run `npm test` and `node_modules/.bin/tsc --noEmit`; browser interoperability still needs the fixtures under `tests/`
