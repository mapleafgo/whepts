#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"
consumer=$(mktemp -d "${TMPDIR:-/tmp}/whepts-package.XXXXXXXX")
consumer=$(realpath "$consumer")
trap 'rm -rf -- "${consumer:?}"' EXIT

source_snapshot() {
  git ls-files -z --cached --others --exclude-standard -- src |
    LC_ALL=C sort -zu |
    while IFS= read -r -d '' path; do
      if [[ -e "$path" || -L "$path" ]]; then
        git hash-object --no-filters -- "$path" || exit 1
      else
        printf '%s\n' missing
      fi
      printf '%s\0' "$path"
    done | sha256sum
}

before=$(source_snapshot)
npm pack --pack-destination "$consumer" --json > "$consumer/pack.json"
after=$(source_snapshot)
test "$before" = "$after"
node -e 'const assert = require("node:assert/strict"); const [pack] = require(process.argv[1]); const files = pack.files.map(f => f.path); for (const path of ["dist/index.js", "dist/index.d.ts"]) assert.ok(files.includes(path), path); assert.ok(!files.some(path => path.startsWith("tests/")))' "$consumer/pack.json"
npm install --prefix "$consumer" --offline --ignore-scripts --no-audit --no-fund "$consumer"/*.tgz

cat > "$consumer/consumer.mts" <<'TS'
import Whep, { type Conf, type State, type WhepDiagnostic, WebRTCError } from 'whepts'

export function startLegacy(container: HTMLVideoElement) {
  const player = new Whep({ url: 'https://example.test/whep', container })
  player.on('state:change', ({ from, to }) => {
    const states: [State, State] = [from, to]
    void states
  })
  player.on('candidate', (candidate: RTCIceCandidate) => void candidate)
  player.on('error', (error: WebRTCError) => void error.message)
  player.pause()
  player.resume()
  player.updateUrl('https://example.test/backup/whep')
  player.close()
}
export const start = (container: HTMLVideoElement) =>
  new Whep({ url: 'https://example.test/whep', container }).on('diagnostic', (record) => {
    const diagnostic: WhepDiagnostic = record
    if (diagnostic.operation === 'sample-flow') void [diagnostic.attemptId, diagnostic.elapsedMs]
  })
TS

cd "$consumer"
"$root/node_modules/.bin/tsc" --noEmit --strict --module nodenext --target es2022 consumer.mts
"$root/node_modules/.bin/tsc" --noEmit --strict --module esnext --moduleResolution bundler --target es2022 consumer.mts
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import Whep, { ErrorTypes, WebRTCError } from 'whepts'

assert.equal(typeof Whep, 'function')
assert.deepEqual(ErrorTypes, {
  SIGNAL_ERROR: 'SignalError',
  STATE_ERROR: 'StateError',
  REQUEST_ERROR: 'RequestError',
  OTHER_ERROR: 'OtherError',
})
const unavailable = new WebRTCError(ErrorTypes.REQUEST_ERROR, 'Service unavailable', {
  phase: 'signaling',
  httpStatus: 503,
})
assert.equal(unavailable.httpStatus, 503)
assert.equal(Object.hasOwn(unavailable, 'reason'), false)
const legacy = new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Signaling failed')
assert.ok(legacy instanceof Error)
assert.equal(legacy.type, ErrorTypes.SIGNAL_ERROR)
for (const field of ['phase', 'reason', 'httpStatus'])
  assert.equal(Object.hasOwn(legacy, field), false, field)
const timeout = new WebRTCError(ErrorTypes.SIGNAL_ERROR, 'Setup timed out', {
  phase: 'signaling',
  reason: 'setup-timeout',
})
assert.equal(timeout.phase, 'signaling')
assert.equal(timeout.reason, 'setup-timeout')
assert.equal(Object.hasOwn(timeout, 'httpStatus'), false)
JS
printf '%s\n' 'Package contents, offline installation, strict types and ESM import verified.'
