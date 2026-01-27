# AGENTS.md - WhepTS Player

## Build/Lint Commands

- `npm run build` - Production build with minification
- `npm run build:debug` - Debug build with source maps
- `npm run lint` - Run ESLint to check code quality
- `npm run lint:fix` - Auto-fix ESLint issues

**Note**: No test framework is currently configured.

## Code Style Guidelines

### Imports

- Use `~/` alias for imports from `src/` (e.g., `import X from '~/utils/observer'`)
- Import types explicitly using `import type { T } from './module'`
- Group external dependencies first, then internal imports

### Formatting

- ESLint uses `@antfu/eslint-config` with formatters enabled
- Run `npm run lint:fix` before committing
- No manual formatting required - let ESLint handle it

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
- Error types: `SIGNAL_ERROR`, `STATE_ERROR`, `NETWORK_ERROR`, `MEDIA_ERROR`, `OTHER_ERROR`
- Pattern: `throw new WebRTCError(ErrorTypes.NETWORK_ERROR, 'message')`
- Call `this.handleError(err)` for centralized error management

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

### File Organization

- Core logic in `src/` directory
- Utilities in `src/utils/` (e.g., `observer.ts`, `flow-check.ts`, `sdp.ts`)
- Error types in `src/errors.ts`
- Export main class from `src/index.ts`

### State Management

- Use union literal types for state (e.g., `'getting_codecs' | 'running' | 'restarting' | 'closed' | 'failed'`)
- Always check state before operations that depend on it
- Use getters for derived properties (e.g., `get isRunning()`)
- `closed` is a final state - once entered, no further operations (except cleanup) are allowed
- Always create private helper methods to reuse common cleanup logic (e.g., `cleanupSession()`)

### Public API Design

- Public methods should have JSDoc comments with usage examples
- When adding new public methods, consider:
  - State validation (reject operations in terminal states like `closed`)
  - Resource cleanup (reuse existing cleanup helpers)
  - State transitions (ensure proper state changes)
  - Event emission (keep users informed)
- Example: `updateUrl()` validates `closed` state, reuses `cleanupSession()`, and restarts playback

### WebRTC Specifics

- Always use `unified-plan` SDP semantics
- Handle ICE candidates with queuing when session URL not ready
- Support non-advertised codecs (PCMA, multiopus, L16)
- Use `IntersectionObserver` for visibility-based playback control

## Tech Stack

- TypeScript 5.9 with strict mode
- Rollup for bundling (ES module output)
- ESLint with @antfu/eslint-config
- pnpm as package manager

## Before Committing

1. Run `npm run lint` and fix all issues
2. Build with `npm run build` to verify production build works
3. No test framework - manually verify WebRTC functionality
