# Event-Driven Architecture Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor WebRTCWhep from callback-based to event-driven architecture using EventEmitter and nanostores.

**Architecture:** WebRTCWhep extends EventEmitter as central event bus. All modules communicate via events. State managed reactively with nanostores.

**Tech Stack:** TypeScript, eventemitter3, nanostores, Rollup, pnpm

---

## Task 1: Add Dependencies

**Files:**

- Modify: `package.json`

**Step 1: Install eventemitter3**

```bash
pnpm add eventemitter3
```

Expected: package.json updated, lockfile updated

**Step 2: Install nanostores**

```bash
pnpm add nanostores
```

Expected: package.json updated, lockfile updated

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat: add eventemitter3 and nanostores dependencies"
```

---

## Task 2: Update Type Definitions

**Files:**

- Modify: `src/types.ts`

**Step 1: Add WhepEvents interface and update Conf**

Read existing types to understand current structure.

**Step 2: Replace Conf.onError with event-based interface**

```typescript
import EventEmitter from 'eventemitter3'

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
  // REMOVED: onError?: (err: WebRTCError) => void
}

/**
 * Event types emitted by WebRTCWhep
 */
export interface WhepEvents {
  'state:change': (payload: { from: State, to: State }) => void
  'candidate': (candidate: RTCIceCandidate) => void
  'track': (evt: RTCTrackEvent) => void
  'error': (err: WebRTCError) => void
  'close': () => void
  'restart': () => void
}
```

**Step 3: Run build to verify types**

```bash
pnpm build
```

Expected: Build passes with type errors (since whep.ts not updated yet)

**Step 4: Commit**

```bash
git add src/types.ts
git commit -m "refactor: update types for event-driven architecture"
```

---

## Task 3: Refactor CodecDetector (Easiest Module)

**Files:**

- Modify: `src/core/codec.ts`

**Step 1: Read existing CodecDetector**

Understand current callback-based implementation.

**Step 2: Update CodecDetector to use emitter**

```typescript
import type { WebRTCError } from '../errors'
import EventEmitter from 'eventemitter3'

export interface CodecDetectorOptions {
  emitter: EventEmitter
}

export class CodecDetector {
  constructor(private options: CodecDetectorOptions) {}

  detect(): void {
    // Detection logic...
    // On success:
    this.options.emitter.emit('codecs:detected', codecs)
    // On error:
    this.options.emitter.emit('error', err)
  }
}
```

**Step 3: Update WebRTCWhep to handle codecs:detected event**

In `src/whep.ts`, update constructor:

```typescript
this.codecDetector = new CodecDetector({ emitter: this })

// Listen to codec detection events
this.on('codecs:detected', (codecs: string[]) => {
  this.handleCodecsDetected(codecs)
})
```

**Step 4: Run build**

```bash
pnpm build
```

**Step 5: Commit**

```bash
git add src/core/codec.ts src/whep.ts
git commit -m "refactor: CodecDetector to use EventEmitter"
```

---

## Task 4: Refactor FlowCheck

**Files:**

- Modify: `src/utils/flow-check.ts`

**Step 1: Read existing FlowCheck**

**Step 2: Update FlowCheck to use emitter**

```typescript
import type { WebRTCError } from '../errors'
import EventEmitter from 'eventemitter3'

export interface FlowCheckOptions {
  interval: number
  emitter: EventEmitter
}

export class FlowCheck {
  constructor(private options: FlowCheckOptions) {
    // On error:
    this.options.emitter.emit('error', err)
  }
}
```

**Step 3: Update WebRTCWhep FlowCheck initialization**

```typescript
this.flowCheck = new FlowCheck({
  interval: 5000,
  emitter: this,
})
```

**Step 4: Run build**

```bash
pnpm build
```

**Step 5: Commit**

```bash
git add src/utils/flow-check.ts src/whep.ts
git commit -m "refactor: FlowCheck to use EventEmitter"
```

---

## Task 5: Refactor HttpClient

**Files:**

- Modify: `src/core/http.ts`

**Step 1: Read existing HttpClient**

**Step 2: Update HttpClient to use emitter**

```typescript
import EventEmitter from 'eventemitter3'

export interface HttpClientOptions {
  conf: Conf
  emitter: EventEmitter
}

export class HttpClient {
  constructor(private options: HttpClientOptions) {}

  private handleError(err: WebRTCError): void {
    this.options.emitter.emit('error', err)
  }
}
```

**Step 3: Update WebRTCWhep HttpClient initialization**

```typescript
this.httpClient = new HttpClient({
  conf: this.conf,
  emitter: this,
})
```

**Step 4: Run build**

```bash
pnpm build
```

**Step 5: Commit**

```bash
git add src/core/http.ts src/whep.ts
git commit -m "refactor: HttpClient to use EventEmitter"
```

---

## Task 6: Refactor ConnectionManager (Most Complex)

**Files:**

- Modify: `src/core/connection.ts`

**Step 1: Read existing ConnectionManager**

**Step 2: Remove ConnectionManagerCallbacks interface**

**Step 3: Update ConnectionManager to use emitter**

```typescript
import type { ParsedOffer } from '../utils/sdp'
import EventEmitter from 'eventemitter3'

export interface ConnectionManagerOptions {
  emitter: EventEmitter
  getNonAdvertisedCodecs: () => string[]
}

export class ConnectionManager {
  constructor(private options: ConnectionManagerOptions) {
    // oncandidate:
    this.options.emitter.emit('candidate', candidate)
    // ontrack:
    this.options.emitter.emit('track', evt)
    // onerror:
    this.options.emitter.emit('error', err)
  }
}
```

**Step 4: Update WebRTCWhep ConnectionManager initialization**

```typescript
this.connectionManager = new ConnectionManager({
  emitter: this,
  getNonAdvertisedCodecs: () => this.nonAdvertisedCodecs,
})

// Listen to events
this.on('candidate', candidate => this.handleCandidate(candidate))
this.on('track', (evt) => {
  this.trackManager.onTrack(evt)
  this.flowCheck.start()
})
```

**Step 5: Run build**

```bash
pnpm build
```

**Step 6: Commit**

```bash
git add src/core/connection.ts src/whep.ts
git commit -m "refactor: ConnectionManager to use EventEmitter"
```

---

## Task 7: Add State Management with nanostores

**Files:**

- Modify: `src/whep.ts`

**Step 1: Import nanostores and create stateStore**

```typescript
import { atom } from 'nanostores'

export default class WebRTCWhep extends EventEmitter<WhepEvents> {
  private stateStore = atom<State>('getting_codecs')

  constructor(conf: Conf) {
    super()
    this.conf = conf

    // Listen to state changes and emit events
    this.stateStore.subscribe((current, previous) => {
      console.log(`State: ${previous} → ${current}`)
      this.emit('state:change', { from: previous, to: current })
    })

    // ... rest of constructor
  }
```

**Step 2: Replace all state assignments with stateStore.set()**

Find all `this.state = ...` and replace with `this.stateStore.set(...)`

**Step 3: Add state getter**

```typescript
get state(): State {
  return this.stateStore.get()
}
```

**Step 4: Update all state checks**

Change `() => this.state` to `() => this.stateStore.get()`

**Step 5: Run build**

```bash
pnpm build
```

**Step 6: Commit**

```bash
git add src/whep.ts
git commit -m "feat: add nanostores for state management"
```

---

## Task 8: Update Error Handling to Use Events

**Files:**

- Modify: `src/whep.ts`

**Step 1: Remove conf.onError callback handling**

Remove from handleError:

```typescript
// REMOVED:
// if (this.conf.onError) {
//   if (err instanceof WebRTCError) {
//     this.conf.onError(err)
//   }
// }
```

**Step 2: Add error re-emission**

After error handling logic, emit to users:

```typescript
private handleError(err: Error | WebRTCError): void {
  // ... existing error handling logic ...

  // Emit to users
  if (err instanceof WebRTCError) {
    this.emit('error', err)
  } else {
    this.emit('error', new WebRTCError(ErrorTypes.OTHER_ERROR, err.message))
  }
}
```

**Step 3: Run build**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add src/whep.ts
git commit -m "refactor: error handling to use events"
```

---

## Task 9: Export WhepEvents Type

**Files:**

- Modify: `src/index.ts`

**Step 1: Export WhepEvents**

```typescript
export type { Conf, State } from './types'
export { default as WebRTCWhep, WhepEvents } from './whep'
```

**Step 2: Add WhepEvents to whep.ts export**

```typescript
export { type WhepEvents }
export default class WebRTCWhep extends EventEmitter<WhepEvents> {
```

**Step 3: Run build**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add src/index.ts src/whep.ts
git commit -m "feat: export WhepEvents type"
```

---

## Task 10: Add close and restart Events

**Files:**

- Modify: `src/whep.ts`

**Step 1: Emit close event**

```typescript
close(): void {
  this.stateStore.set('closed')
  this.connectionManager.close()
  this.trackManager.stop()
  this.flowCheck.close()
  if (this.restartTimeout) {
    clearTimeout(this.restartTimeout)
  }
  this.emit('close')
}
```

**Step 2: Emit restart event**

In handleError, when transitioning to restarting:

```typescript
this.stateStore.set('restarting')
this.emit('restart')
```

**Step 3: Run build**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add src/whep.ts
git commit -m "feat: add close and restart events"
```

---

## Task 11: Run Linter and Fix Issues

**Files:**

- All TypeScript files

**Step 1: Run linter**

```bash
pnpm lint
```

**Step 2: Fix lint issues**

```bash
pnpm lint:fix
```

**Step 3: Run build**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add -A
git commit -m "style: fix lint issues"
```

---

## Task 12: Update Documentation

**Files:**

- Modify: `README.md`
- Modify: `CLAUDE.md`

**Step 1: Update README.md with new usage examples**

````markdown
## Usage

\```typescript
import WebRTCWhep from 'whepts'

const whep = new WebRTCWhep({
url: 'https://example.com/whep',
container: document.querySelector('video')
})

// Listen to events
whep.on('state:change', ({ from, to }) => {
console.log(`State: ${from} → ${to}`)
})

whep.on('track', (evt) => {
console.log('Track received', evt.track.kind)
})

whep.on('error', (err) => {
console.error('Error:', err.message, err.type)
})

whep.on('close', () => {
console.log('Connection closed')
})
\```
````

**Step 2: Update CLAUDE.md architecture section**

Update the architecture description to reflect event-driven design.

**Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update for event-driven architecture"
```

---

## Task 13: Final Build and Verification

**Files:**

- All files

**Step 1: Clean build**

```bash
rm -rf dist
pnpm build
```

**Step 2: Verify dist output**

```bash
ls -lh dist/
```

Expected: dist/index.js created successfully

**Step 3: Verify no TypeScript errors**

Check build output for type errors

**Step 4: Run linter**

```bash
pnpm lint
```

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete event-driven architecture refactor"
```

---

## Task 14: Merge to Main

**Files:**

- Git operations

**Step 1: Switch back to main**

```bash
cd ../..
git checkout main
```

**Step 2: Merge feature branch**

```bash
git merge feature/event-driven-refactor --no-ff
```

**Step 3: Push to remote**

```bash
git push
```

**Step 4: Clean up worktree**

```bash
git worktree remove .worktrees/event-driven-refactor
git branch -d feature/event-driven-refactor
```

---

## Testing Notes

While this plan doesn't include explicit test files, verify each step by:

1. **Build verification**: Run `pnpm build` after each module change
2. **Type checking**: TypeScript compiler will catch type mismatches
3. **Manual testing**: Create a simple HTML file that uses the library to verify events are emitted correctly
4. **Linting**: Run `pnpm lint` to catch code style issues

## Migration Guide for Users

Include in README or MIGRATION.md:

````markdown
## Migration from v1.x to v2.0

### Breaking Changes

1. **Error handling**: `conf.onError` callback removed. Use event listener instead.

   **Old:**
   \```typescript
   const whep = new WebRTCWhep({
   url: '...',
   container: video,
   onError: (err) => console.error(err)
   })
   \```

   **New:**
   \```typescript
   const whep = new WebRTCWhep({
   url: '...',
   container: video
   })
   whep.on('error', (err) => console.error(err))
   \```

2. **State changes**: Listen to `state:change` event for state transitions.

   \```typescript
whep.on('state:change', ({ from, to }) => {
  console.log(`State: ${from} → ${to}`)
   })
   \```

3. **New events available**:
   - `state:change` - State transitions
   - `candidate` - ICE candidates
   - `track` - Media tracks
   - `error` - Errors
   - `close` - Connection closed
   - `restart` - Reconnection starting
````
