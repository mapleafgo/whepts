# Event-Driven Architecture Refactor Design

**Date**: 2026-01-26
**Status**: Draft
**Author**: Claude Code

## Overview

Refactor WebRTCWhep from callback-based architecture to event-driven architecture using EventEmitter and nanostores for state management. This reduces coupling between modules and provides a more consistent, extensible API.

## Goals

1. Replace all callback functions with EventEmitter-based events
2. Implement formal state management using nanostores
3. Reduce coupling between modules
4. Provide consistent event-driven API for users

## Dependencies

- **eventemitter3** (~1KB) - TypeScript-friendly EventEmitter
- **nanostores** (~1KB) - Lightweight reactive state management
- Total增量: ~2KB

## Architecture

### EventEmitter Design

WebRTCWhep itself extends EventEmitter, serving as the central event bus for the entire library.

```typescript
import EventEmitter from 'eventemitter3'

export interface WhepEvents {
  'state:change': (payload: { from: State, to: State }) => void
  'candidate': (candidate: RTCIceCandidate) => void
  'track': (evt: RTCTrackEvent) => void
  'error': (err: WebRTCError) => void
  'close': () => void
  'restart': () => void
}

export default class WebRTCWhep extends EventEmitter<WhepEvents>
```

### State Management with nanostores

Use nanostores' `atom` for reactive state management:

```typescript
import { atom } from 'nanostores'

private stateStore = atom<State>('getting_codecs')

// State transition
this.stateStore.set('running')

// Listen to state changes
this.stateStore.subscribe((current, previous) => {
  console.log(`State: ${previous} → ${current}`)
  this.emit('state:change', { from: previous, to: current })
})

// External access
get state(): State {
  return this.stateStore.get()
}
```

**Relaxed mode**: No strict state transition validation. State can be freely assigned, but all changes are logged via nanostores middleware for debugging.

## Module Refactoring

### Principle: Dependency Injection

All modules no longer accept callback functions. Instead, they receive dependencies via configuration objects.

### HttpClient

**Before**:

```typescript
new HttpClient(conf, getState, onError)
```

**After**:

```typescript
new HttpClient({ conf, emitter })
```

Emits: `error`

### ConnectionManager

**Before**:

```typescript
new ConnectionManager(
  getState,
  {
    onCandidate: candidate => ...,
    onTrack: evt => ...,
    onError: err => ...
  },
  getNonAdvertisedCodecs
)
```

**After**:

```typescript
new ConnectionManager({ emitter, getNonAdvertisedCodecs })
```

Emits: `candidate`, `track`, `error`

### CodecDetector

**Before**:

```typescript
new CodecDetector(getState, {
  onCodecsDetected: codecs => ...,
  onError: err => ...
})
```

**After**:

```typescript
new CodecDetector({ emitter })
```

Emits: `codecs:detected`, `error`

### FlowCheck

**Before**:

```typescript
new FlowCheck({ interval, onError })
```

**After**:

```typescript
new FlowCheck({ interval, emitter })
```

Emits: `error`

### TrackManager

No changes needed. Only passively controlled by WebRTCWhep.

## Error Handling

### Breaking Change: Remove Conf.onError

**Before**:

```typescript
const whep = new WebRTCWhep({
  url: '...',
  container: video,
  onError: err => console.error(err)
})
```

**After**:

```typescript
const whep = new WebRTCWhep({
  url: '...',
  container: video
})

whep.on('error', (err) => {
  console.error(err.message, err.type)
})
```

### Error Propagation Flow

1. Sub-modules emit `error` event via emitter
2. WebRTCWhep listens to all `error` events
3. handleError() determines handling strategy based on current state
4. After processing, WebRTCWhep re-emits `error` to users

### Error Handling Logic (Unchanged)

- Errors in `getting_codecs` state → transition to `failed`
- SIGNAL_ERROR/NOT_FOUND_ERROR/REQUEST_ERROR → transition to `failed`
- Errors in `running` state → cleanup, transition to `restarting`, retry after 2s
- Retry errors append ", retrying in some seconds" to message

## Data Flow

```
WebRTCWhep (EventEmitter)
  ├─ stateStore (nanostores atom)
  │
  ├─ Listens to:
  │  ├─ CodecDetector: 'codecs:detected', 'error'
  │  ├─ HttpClient: 'error'
  │  ├─ ConnectionManager: 'candidate', 'track', 'error'
  │  └─ FlowCheck: 'error'
  │
  └─ Emits to users:
     ├─ 'state:change'
     ├─ 'candidate'
     ├─ 'track'
     ├─ 'error'
     ├─ 'close'
     └─ 'restart'
```

## Lifecycle

1. **Construction**:
   - WebRTCWhep creates EventEmitter and stateStore
   - Create all sub-modules, inject `emitter` (this)
   - WebRTCWhep subscribes to all sub-module events

2. **Event Handling**:
   - `codecs:detected` → Update nonAdvertisedCodecs, state→running, start connection
   - `candidate` → Send to server
   - `track` → Notify TrackManager, start FlowCheck
   - `error` → Call handleError

3. **State Changes**:
   - Automatically trigger `state:change` event via nanostores subscription

## Migration Strategy (No Backward Compatibility)

Since backward compatibility is not required, we can refactor directly:

### Phase 1: Infrastructure

- Install `eventemitter3` and `nanostores`
- WebRTCWhep extends EventEmitter
- Create stateStore
- Set up event type definitions

### Phase 2: Module Migration

Migrate modules in order of simplicity:

1. CodecDetector (simplest, most independent)
2. FlowCheck
3. HttpClient
4. ConnectionManager (most complex)

### Phase 3: Cleanup

- Remove all callback interface definitions
- Remove `Conf.onError`
- Update TypeScript types

### Phase 4: Documentation

- Update README with new usage examples
- Document breaking changes
- Update CLAUDE.md

## Testing Strategy

- **Unit Tests**: Verify each module emits correct events
- **Integration Tests**: Verify WebRTCWhep correctly handles all events
- **State Transition Tests**: Verify all state changes trigger `state:change`
- **Error Handling Tests**: Verify errors propagate to user layer correctly

## Benefits

1. **Reduced Coupling**: Modules only depend on emitter, not parent callbacks
2. **Consistent API**: All interactions use events
3. **Better Extensibility**: Easy to add new events without changing interfaces
4. **Improved Testability**: Easier to mock and test event emissions
5. **Reactive State**: nanostores provides reactive state management
6. **Better Debugging**: All state changes and events are logged

## Trade-offs

1. **Breaking Change**: Users must update code (acceptable since no backward compat needed)
2. **Learning Curve**: Users must learn event-based API
3. **Package Size**: +2KB for new dependencies (minimal impact)

## File Changes

- `src/types.ts`: Remove `Conf.onError`, add `WhepEvents` interface
- `src/whep.ts`: Extends EventEmitter, refactor to use events
- `src/core/http.ts`: Remove callback, use emitter
- `src/core/connection.ts`: Remove `ConnectionManagerCallbacks`, use emitter
- `src/core/codec.ts`: Remove callbacks, use emitter
- `src/utils/flow-check.ts`: Remove `onError`, use emitter
- `package.json`: Add `eventemitter3` and `nanostores` dependencies
