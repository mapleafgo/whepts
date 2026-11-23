import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- 使用 Node 内置测试运行器，不新增依赖。
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
// eslint-disable-next-line antfu/no-import-dist -- 回归测试验证实际构建入口。
import WebRTCWhep, { ErrorTypes, WebRTCError } from '../dist/index.js'

test('complete ICE waits for gathering and posts the final SDP without PATCH', async (t) => {
  let peer
  const sent = []
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n'
  class Peer extends EventTarget {
    iceGatheringState = 'gathering'
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { type: 'offer', sdp }
    }

    async setLocalDescription(offer) { this.localDescription = offer }
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (_url, { method, body }) => {
    sent.push([method, body])
    return method === 'POST' ? new Promise(() => {}) : new Response(null, { status: 204 })
  })
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false, iceMode: 'complete' })
  t.after(() => player.close())
  await setImmediate()
  assert.deepEqual(sent.map(([method]) => method), ['OPTIONS'])
  peer.onicecandidate({ candidate: { sdpMLineIndex: 0, candidate: 'candidate:test' } })
  peer.localDescription = { type: 'offer', sdp: `${sdp}a=candidate:test\r\n` }
  peer.iceGatheringState = 'complete'
  peer.dispatchEvent(new Event('icegatheringstatechange'))
  await setImmediate()
  assert.deepEqual(sent.map(([method]) => method), ['OPTIONS', 'POST'])
  assert.match(sent[1][1], /a=candidate:test/)
})

test('a pending stats request prevents overlapping samples', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000 })
  let peer
  let samples = 0
  const page = Object.assign(new EventTarget(), { hidden: false })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
  t.after(() => Reflect.deleteProperty(globalThis, 'document'))
  const pending = new Promise(() => {})
  let getStats = () => pending
  class Peer {
    connectionState = 'connected'
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    getStats() {
      samples++
      return getStats()
    }

    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, { method }) => method === 'POST' ? pending : new Response(null, { status: 204 }))
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const diagnostics = []
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container,
    lazyLoad: false,
    onDiagnostic(record) {
      diagnostics.push(record)
      throw new Error('Host flow diagnostic observer failed')
    },
  })
  t.after(() => player.close())
  await setImmediate()
  peer.onconnectionstatechange()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  for (let i = 0; i < 30; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(samples, 1)
  assert.equal(player.state, 'running')
  assert.deepEqual(fetchMock.mock.calls.map(call => call.arguments[1].method), ['OPTIONS', 'POST'])
  assert.deepEqual(diagnostics.map(({ operation, reason, attemptId }) => [operation, reason, attemptId]), [['sample-flow', 'timeout', 1]])
  player.updateUrl('https://player.example/b')
  await setImmediate()
  const stalls = []
  player.on('flow:stalled', event => stalls.push(event))
  getStats = async () => new Map()
  peer.onconnectionstatechange()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  const samplingStarted = samples
  for (let i = 0; i < 21; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(samples - samplingStarted, 5)
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(samples - samplingStarted, 7)
  t.mock.timers.tick(1000)
  await setImmediate()
  assert.equal(samples - samplingStarted, 7)
  for (let i = 0; i < 9; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(samples - samplingStarted, 8)
  assert.deepEqual(stalls, [])
  getStats = async () => new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 80 }]])
  for (let i = 0; i < 30; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  page.hidden = true
  page.dispatchEvent(new Event('visibilitychange'))
  page.hidden = false
  page.dispatchEvent(new Event('visibilitychange'))
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.deepEqual(stalls, [])

  // 最后一条报告不变时，仍应识别第一条报告上的进度。
  let receivedBytes = 100
  let advancing = true
  getStats = async () => new Map([
    ['active', { id: 'active', type: 'inbound-rtp', kind: 'video', bytesReceived: advancing ? ++receivedBytes : receivedBytes }],
    ['idle', { id: 'idle', type: 'inbound-rtp', kind: 'video', bytesReceived: 10 }],
  ])
  for (let i = 0; i < 40; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.deepEqual(stalls, [])
  advancing = false
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.deepEqual(stalls, [])
  t.mock.timers.tick(120000)
  await setImmediate()
  assert.deepEqual(stalls, [])
  for (let i = 0; i < 51; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(stalls.length, 1)
  const delayed = Promise.withResolvers()
  const latestStats = getStats
  getStats = () => delayed.promise
  for (let i = 0; i < 25; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  delayed.resolve(await latestStats())
  getStats = latestStats
  await setImmediate()
  for (let i = 0; i < 21; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(stalls.length, 1)
  assert.equal(player.state, 'running')

  const late = Promise.withResolvers()
  const beforeSample = samples
  getStats = () => late.promise
  for (let i = 0; i < 45; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
    if (samples !== beforeSample)
      break
  }
  assert.equal(samples, beforeSample + 1)
  const beforeDiagnostic = diagnostics.length
  t.mock.timers.setTime(Date.now() + 6000)
  late.resolve(await latestStats())
  await setImmediate()
  assert.equal(diagnostics.length, beforeDiagnostic + 1)
  const { elapsedMs, ...overdue } = diagnostics.at(-1)
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0)
  assert.deepEqual(overdue, {
    playerId: diagnostics[0].playerId,
    attemptId: 2,
    state: 'running',
    operation: 'sample-flow',
    phase: 'connection',
    reason: 'timeout',
  })
  getStats = latestStats
  t.mock.timers.tick(6000)
  await setImmediate()
  assert.equal(diagnostics.length, beforeDiagnostic + 1)

  const cancelled = Promise.withResolvers()
  const beforeCancel = samples
  getStats = () => cancelled.promise
  for (let i = 0; i < 45; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
    if (samples !== beforeCancel)
      break
  }
  assert.equal(samples, beforeCancel + 1)
  player.close()
  t.mock.timers.tick(6000)
  cancelled.reject(new Error('Retired peer statistics unavailable'))
  await setImmediate()
  assert.equal(player.state, 'closed')
  assert.equal(diagnostics.length, beforeDiagnostic + 1)
})

test('close releases its stream but leaves a replacement attached by the host', async (t) => {
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  for (const hostTakesOver of [false, true]) {
    const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
    const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
    t.after(() => player.close())
    await setImmediate()
    const ownedStream = { getTracks: () => [{ kind: 'video' }] }
    peer.ontrack({ streams: [ownedStream] })
    assert.equal(container.srcObject, ownedStream)
    const hostStream = {}
    if (hostTakesOver)
      container.srcObject = hostStream
    player.close()
    assert.equal(container.srcObject, hostTakesOver ? hostStream : null)
  }
})
test('audio-first streamless tracks wait for video and attach together', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  class Stream {
    constructor(tracks) { this.tracks = tracks }
    getTracks() { return this.tracks }
  }
  Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: Stream })
  t.after(() => Reflect.deleteProperty(globalThis, 'MediaStream'))
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  await setImmediate()
  const audio = { kind: 'audio' }
  function videoTrack() {
    return Object.assign(new EventTarget(), { kind: 'video', readyState: 'live' })
  }
  const video = videoTrack()
  const failures = []
  player.on('play:failed', ({ code }) => failures.push(code))
  peer.ontrack({ streams: [], track: audio })
  peer.connectionState = 'connected'
  peer.onconnectionstatechange()
  t.mock.timers.tick(5000)
  assert.equal(container.srcObject, null)
  assert.equal(player.state, 'running')
  assert.deepEqual(failures, ['video-unavailable'])
  peer.ontrack({ streams: [], track: video })
  assert.deepEqual(container.srcObject.getTracks(), [audio, video])
  video.readyState = 'ended'
  video.dispatchEvent(new Event('ended'))
  assert.equal(container.srcObject, null)
  assert.deepEqual(failures, ['video-unavailable', 'video-unavailable'])
  assert.equal(player.state, 'running')
  const replacement = videoTrack()
  peer.ontrack({ streams: [], track: replacement })
  assert.deepEqual(container.srcObject.getTracks(), [audio, replacement])
  video.dispatchEvent(new Event('ended'))
  assert.deepEqual(container.srcObject.getTracks(), [audio, replacement])
  assert.deepEqual(failures, ['video-unavailable', 'video-unavailable'])
  assert.equal(player.state, 'running')
})

test('visibility changes respect the threshold and manual pause', async (t) => {
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  let report
  class Observer {
    constructor(callback) { report = callback }
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: Observer })
  t.after(() => Reflect.deleteProperty(globalThis, 'IntersectionObserver'))
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container })
  t.after(() => player.close())
  await setImmediate()
  const stream = { getTracks: () => [{ kind: 'video' }] }
  peer.ontrack({ streams: [stream] })
  const show = ratio => report([{ isIntersecting: ratio > 0, intersectionRatio: ratio }])
  show(0.25)
  assert.equal(container.srcObject, null)
  show(0.5)
  assert.equal(container.srcObject, stream)
  player.pause()
  show(0)
  show(1)
  assert.equal(container.srcObject, null)
  player.resume()
  assert.equal(container.srcObject, stream)
})

test('autoplay denial reports a reason code without muting or retrying', async (t) => {
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  let plays = 0
  const container = {
    srcObject: null,
    paused: true,
    muted: false,
    addEventListener() {},
    removeEventListener() {},
    async play() {
      plays++
      throw new DOMException('Blocked', 'NotAllowedError')
    },
  }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  const failures = []
  player.on('play:failed', failure => failures.push(failure))
  player.on('play:failed', () => {
    throw new Error('Observer failed')
  })
  await setImmediate()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  await setImmediate()
  assert.equal(plays, 1)
  assert.equal(container.muted, false)
  assert.deepEqual(failures.map(({ code, muted }) => [code, muted]), [['autoplay-blocked', false]])
  assert.equal(player.state, 'running')
})

test('pending play rejection after a host stream takeover is ignored', async (t) => {
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  const result = Promise.withResolvers()
  const container = {
    srcObject: null,
    paused: true,
    muted: false,
    addEventListener() {},
    removeEventListener() {},
    play: () => result.promise,
  }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  const failures = []
  player.on('play:failed', failure => failures.push(failure))
  await setImmediate()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  const takeover = {}
  container.srcObject = takeover
  result.reject(new DOMException('Replaced', 'AbortError'))
  await setImmediate()
  assert.deepEqual(failures, [])
  assert.equal(player.state, 'running')
  player.close()
  assert.equal(container.srcObject, takeover)
})

test('advancing inbound video bytes without video frames reports playback stall', async (t) => {
  let peer
  let receivedBytes = 0
  class Peer {
    connectionState = 'connected'
    async getStats() {
      receivedBytes += 128
      return new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: receivedBytes }]])
    }

    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
  const container = Object.assign(new EventTarget(), {
    srcObject: null,
    paused: true,
    currentTime: 0,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }),
    async play() { this.paused = false },
  })
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  const stalls = []
  const flowStalls = []
  player.on('flow:stalled', event => flowStalls.push(event))
  player.on('play:stalled', event => stalls.push(event.reason))
  await setImmediate()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  await setImmediate()
  peer.onconnectionstatechange()
  for (let i = 0; i < 17; i++) {
    container.currentTime += 1
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.ok(receivedBytes >= 256)
  assert.deepEqual(flowStalls, [])
  t.mock.timers.tick(500)
  assert.deepEqual(stalls, ['No video frames presented'])
  container.error = new Error('Private playback detail')
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.ok(stalls.some(reason => reason.includes('currentTime not advancing')))
  assert.doesNotMatch(stalls.join(' '), /Private playback detail/)
  const beforeTakeover = stalls.length
  container.srcObject = {}
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(stalls.length, beforeTakeover)
  assert.equal(player.state, 'running')
})

test('element recovery exhaustion reports playback failure without closing transport', async (t) => {
  let peer
  let closedPlaybackPeers = 0
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {
      if (this === peer)
        closedPlaybackPeers++
    }
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const fetchMock = t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let plays = 0
  const container = Object.assign(new EventTarget(), {
    srcObject: null,
    paused: true,
    muted: false,
    currentTime: 0,
    async play() {
      plays++
      if (plays > 1)
        throw new DOMException('Internal media detail', 'NotSupportedError')
    },
  })
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  await setImmediate()
  const failures = []
  player.on('play:failed', ({ code }) => failures.push(code))
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  await setImmediate()
  container.error = { code: 3, message: 'Internal media detail' }
  container.dispatchEvent(new Event('error'))
  container.dispatchEvent(new Event('error'))
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(plays, 4)
  assert.deepEqual(failures, ['element-recovery-exhausted'])
  container.dispatchEvent(new Event('error'))
  t.mock.timers.tick(5000)
  await setImmediate()
  assert.equal(plays, 4)
  assert.deepEqual(failures, ['element-recovery-exhausted'])
  assert.equal(player.state, 'running')
  assert.equal(closedPlaybackPeers, 0)
  assert.deepEqual(fetchMock.mock.calls.map(call => call.arguments[1].method), ['OPTIONS', 'POST'])
})

test('host stream takeover cancels pending media recovery writes', async (t) => {
  let peer
  let closedPlaybackPeers = 0
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {
      if (this === peer)
        closedPlaybackPeers++
    }
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const fetchMock = t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let plays = 0
  const container = Object.assign(new EventTarget(), {
    srcObject: null,
    paused: true,
    muted: false,
    currentTime: 0,
    async play() {
      plays++
      if (plays > 1)
        throw new DOMException('Internal media detail', 'NotSupportedError')
    },
  })
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  await setImmediate()
  const failures = []
  player.on('play:failed', ({ code }) => failures.push(code))
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  await setImmediate()
  container.error = { code: 3, message: 'Internal media detail' }
  container.dispatchEvent(new Event('error'))
  const replacement = {}
  container.srcObject = replacement
  t.mock.timers.tick(1000)
  await setImmediate()
  assert.equal(container.srcObject, replacement)
  assert.equal(plays, 1)
  assert.deepEqual(failures, [])
  assert.equal(closedPlaybackPeers, 0)
  assert.deepEqual(fetchMock.mock.calls.map(call => call.arguments[1].method), ['OPTIONS', 'POST'])
})

test('close deletes a known session before its answer body settles', async (t) => {
  for (const reason of ['http-error', 'request-failed', 'timeout']) {
    await t.test(reason, async (t) => {
      const cleanupDeadline = new AbortController()
      if (reason === 'timeout') {
        t.mock.method(AbortSignal, 'timeout', (ms) => {
          assert.equal(ms, 5000)
          return cleanupDeadline.signal
        })
      }
      const requests = []
      const diagnostics = []
      let peerClosed = false
      const closedAtDelete = []
      const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n'
      class Peer {
        addTransceiver() {}
        async createOffer() { return { type: 'offer', sdp } }
        async setLocalDescription() {}
        async setRemoteDescription() {}
        close() {
          if (this.ontrack !== undefined)
            peerClosed = true
        }
      }
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push([options.method, String(url)])
        if (options.method === 'POST') {
          return new Response(new ReadableStream({}), {
            status: 201,
            headers: { Location: '/session/a' },
          })
        }
        if (options.method === 'DELETE') {
          closedAtDelete.push(peerClosed)
          if (reason === 'timeout') {
            assert.equal(options.signal, cleanupDeadline.signal)
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
            })
          }
          if (reason === 'request-failed')
            throw new TypeError('Private cleanup detail')
          return new Response('Private cleanup detail', { status: 503 })
        }
        return new Response(null, { status: 204 })
      })
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
      t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
      const player = new WebRTCWhep({
        url: 'https://player.example/a',
        container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
        lazyLoad: false,
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic)
          throw new Error('Host diagnostic observer failed')
        },
      })
      t.after(() => player.close())
      await setImmediate()
      assert.ok(requests.some(([method]) => method === 'POST'))
      const observations = []
      player.on('state:change', ({ to }) => {
        if (to === 'closed')
          observations.push(requests.some(([method]) => method === 'DELETE'))
      })
      player.close()
      assert.deepEqual(observations, [true])
      assert.deepEqual(closedAtDelete, [false])
      assert.equal(peerClosed, false)
      player.close()
      assert.deepEqual(requests.filter(([method]) => method === 'DELETE'), [
        ['DELETE', 'https://player.example/session/a'],
      ])
      if (reason === 'timeout') {
        assert.deepEqual(diagnostics, [])
        cleanupDeadline.abort(new DOMException('Private cleanup detail', 'TimeoutError'))
      }
      await setImmediate()
      assert.equal(player.state, 'closed')
      assert.equal(diagnostics.length, 1)
      const [{ elapsedMs, playerId, attemptId, state, ...diagnostic }] = diagnostics
      assert.ok(Number.isInteger(playerId) && playerId > 0)
      assert.ok(Number.isInteger(attemptId) && attemptId > 0)
      assert.equal(state, 'closed')
      assert.equal(peerClosed, true)
      assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0)
      assert.deepEqual(diagnostic, { operation: 'delete-session', phase: 'signaling', reason, ...(reason === 'http-error' ? { httpStatus: 503 } : {}) })
      assert.ok(!JSON.stringify(diagnostics).includes('Private cleanup detail'))
    })
  }
})

test('a late POST response deletes only the retired session', async (t) => {
  const answers = []
  const deleted = []
  const diagnostics = []
  const oldResponse = Promise.withResolvers()
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:camera\r\n'
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp } }
    async setLocalDescription() {}
    async setRemoteDescription() {
      if (this.isPlaybackPeer)
        answers.push(this)
    }

    get isPlaybackPeer() { return typeof this.ontrack === 'function' }
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {} })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
    Reflect.deleteProperty(globalThis, 'RTCSessionDescription')
  })
  let postedA = false
  t.mock.method(globalThis, 'fetch', async (url, { method, headers }) => {
    if (method === 'DELETE') {
      deleted.push([url, new Headers(headers).get('Authorization')])
      return new Response(null, { status: 503 })
    }
    if (method !== 'POST')
      return new Response(null, { status: 204 })
    if (new URL(url).pathname === '/a') {
      postedA = true
      return oldResponse.promise
    }
    return new Response(sdp, { status: 201, headers: { Location: 'https://player.example/session/b' } })
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    token: 'fixture-token',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
    onDiagnostic: record => diagnostics.push(record),
  })
  t.after(() => player.close())
  await setImmediate()
  assert.ok(postedA)
  player.updateUrl('https://other.example/b')
  await setImmediate()
  assert.equal(answers.length, 1)
  const redirected = new Response(sdp, { status: 201, headers: { Location: '../session/a' } })
  Object.defineProperty(redirected, 'url', { value: 'https://player.example/proxy/live/whep' })
  oldResponse.resolve(redirected)
  await setImmediate()
  assert.equal(answers.length, 1)
  assert.equal(player.state, 'running')
  assert.deepEqual(deleted, [['https://player.example/proxy/session/a', 'Bearer fixture-token']])
  assert.deepEqual(diagnostics.map(({ attemptId, state }) => [attemptId, state]), [[1, 'running']])
  player.close()
  await setImmediate()
  assert.deepEqual(diagnostics.map(({ attemptId, state }) => [attemptId, state]), [[1, 'running'], [2, 'closed']])
  assert.equal(diagnostics[0].playerId, diagnostics[1].playerId)
  assert.deepEqual(deleted, [['https://player.example/proxy/session/a', 'Bearer fixture-token'], ['https://player.example/session/b', null]])
})

test('only the latest source starts after codec discovery without mutating configuration', async (t) => {
  const requests = []
  const conf = Object.freeze({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.mock.method(globalThis, 'fetch', (url) => {
    requests.push(url)
    return new Promise(() => {})
  })
  const player = new WebRTCWhep(conf)
  t.after(() => player.close())
  player.updateUrl('https://player.example/b')
  player.updateUrl('https://player.example/c')
  await setImmediate()
  assert.deepEqual(requests, ['https://player.example/c'])
  assert.equal(conf.url, 'https://player.example/a')
})

test('a retired OPTIONS response cannot start a second POST', async (t) => {
  const retired = Promise.withResolvers()
  const requests = []
  let oldSignal
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (url, { method, signal }) => {
    const path = new URL(url).pathname
    requests.push([method, path])
    if (method === 'OPTIONS' && path === '/a') {
      oldSignal = signal
      return retired.promise
    }
    return method === 'OPTIONS' ? new Response(null, { status: 204 }) : new Promise(() => {})
  })
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push(error))
  await setImmediate()
  player.updateUrl('https://player.example/b')
  await setImmediate()
  assert.equal(oldSignal.aborted, true)
  retired.resolve(new Response(null, { status: 204 }))
  await setImmediate()
  assert.deepEqual(requests, [['OPTIONS', '/a'], ['OPTIONS', '/b'], ['POST', '/b']])
  assert.deepEqual(errors, [])
})

test('an SDP body that outlives the deadline cleans up its registered session once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let answers = 0
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
    async setLocalDescription() {}
    async setRemoteDescription() {
      if (this.ontrack)
        answers++
    }

    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const requests = []
  const body = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (url, { method }) => {
    requests.push([method, url])
    return method === 'POST'
      ? { status: 201, headers: new Headers({ Location: '/session/a' }), text: () => body.promise }
      : new Response(null, { status: 204 })
  })
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push([player.state, error.phase, error.reason]))
  await setImmediate()
  assert.deepEqual(requests.map(([method]) => method), ['OPTIONS', 'POST'])
  t.mock.timers.tick(15000)
  body.resolve('v=0\r\n')
  await setImmediate()
  assert.deepEqual(errors, [['failed', 'signaling', 'setup-timeout']])
  assert.equal(answers, 0)
  player.close()
  assert.deepEqual(requests, [['OPTIONS', 'https://player.example/a'], ['POST', 'https://player.example/a'], ['DELETE', 'https://player.example/session/a']])
})

test('an unanswered POST expires without guessing a session or retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const methods = []
  const retired = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    methods.push(method)
    return method === 'POST' ? retired.promise : new Response(null, { status: 204 })
  })
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push([player.state, error.phase]))
  await setImmediate()
  assert.deepEqual(methods, ['OPTIONS', 'POST'])
  t.mock.timers.tick(15000)
  assert.deepEqual(errors, [['failed', 'signaling']])
  retired.reject(new TypeError('Late network error'))
  await setImmediate()
  t.mock.timers.tick(15000)
  assert.deepEqual(errors, [['failed', 'signaling']])
  assert.deepEqual(methods, ['OPTIONS', 'POST'])
})

test('ICE failure and setup deadline before connection report only once', async (t) => {
  for (const iceFirst of [true, false]) {
    await t.test(iceFirst ? 'ICE failure first' : 'deadline first', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      let peer
      class Peer {
        connectionState = 'new'
        addTransceiver() {}
        async createOffer() {
          if (this.onconnectionstatechange)
            peer = this
          return { type: 'offer', sdp: 'v=0\r\n' }
        }

        async setLocalDescription() {}
        close() {}
      }
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
      t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
      const methods = []
      const retired = Promise.withResolvers()
      t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
        methods.push(method)
        return method === 'POST' ? retired.promise : new Response(null, { status: 204 })
      })
      const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
      const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
      t.after(() => player.close())
      const errors = []
      player.on('error', error => errors.push([player.state, error.phase]))
      await setImmediate()
      assert.deepEqual(methods, ['OPTIONS', 'POST'])
      const failIce = peer.onconnectionstatechange
      peer.connectionState = 'failed'
      if (iceFirst)
        failIce()
      t.mock.timers.tick(15000)
      if (!iceFirst)
        failIce()
      assert.deepEqual(errors, [['failed', iceFirst ? 'connection' : 'signaling']])
      retired.reject(new TypeError('Late network error'))
      await setImmediate()
      t.mock.timers.tick(15000)
      assert.deepEqual(errors, [['failed', iceFirst ? 'connection' : 'signaling']])
      assert.deepEqual(methods, ['OPTIONS', 'POST'])
    })
  }
})

test('an unusable Location does not discard an otherwise valid answer', async (t) => {
  for (const [label, location] of [
    ['not exposed', null],
    ['malformed', 'http://['],
    ['unsupported protocol', 'ftp://player.example/session'],
    ['embedded credentials', 'https://viewer:secret@player.example/session'],
  ]) {
    await t.test(label, async (t) => {
      let peer
      const methods = []
      const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:camera\r\n'
      class Peer {
        addTransceiver() {}
        async createOffer() { return { type: 'offer', sdp } }
        async setLocalDescription() {}
        async setRemoteDescription() {
          if (this.ontrack)
            peer = this
        }

        close() {}
      }
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
      Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {} })
      t.after(() => {
        Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
        Reflect.deleteProperty(globalThis, 'RTCSessionDescription')
      })
      t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
        methods.push(method)
        return method === 'POST'
          ? new Response(sdp, { status: 201, headers: location === null ? {} : { Location: location } })
          : new Response(null, { status: 204 })
      })
      const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
      const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
      t.after(() => player.close())
      await setImmediate()
      assert.equal(player.state, 'running')
      assert.ok(peer)
      peer.onicecandidate({ candidate: { sdpMid: 'camera', candidate: 'candidate:test' } })
      player.close()
      assert.deepEqual(methods, ['OPTIONS', 'POST'])
    })
  }
})

test('an SDP answer rejection cleans up the registered session once', async (t) => {
  const methods = []
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:camera\r\n'
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp } }
    async setLocalDescription() {}
    async setRemoteDescription() {
      if (this.ontrack)
        throw new Error('Private SDP parser detail')
    }

    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {} })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
    Reflect.deleteProperty(globalThis, 'RTCSessionDescription')
  })
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    methods.push(method)
    return method === 'POST'
      ? new Response(sdp, { status: 201, headers: { Location: '/session/answer' } })
      : new Response(null, { status: 204 })
  })
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push([player.state, error]))
  await setImmediate()
  assert.equal(errors.length, 1)
  const [[state, error]] = errors
  assert.equal(state, 'failed')
  assert.ok(error instanceof WebRTCError)
  assert.equal(error.phase, 'connection')
  assert.doesNotMatch(error.message, /Private SDP parser detail/)
  player.close()
  assert.deepEqual(methods, ['OPTIONS', 'POST', 'DELETE'])
})

test('a 406 counter-offer completes the session with an SDP PATCH', async (t) => {
  const calls = []
  let issuedPeer
  let emitTrickle
  // 草案示例的 406 响应带 o= 与 ice-pwd；校验按此最小结构判定。
  const counterOffer = 'v=0\r\no=- 2438602337097565327 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:server\r\na=ice-pwd:server-pwd\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n'
  Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {} })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCSessionDescription'))
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:client\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' } }
    async setLocalDescription() {}
    async setRemoteDescription(description) {
      issuedPeer = this
      emitTrickle = candidate => this.onicecandidate?.({ candidate })
      calls.push(['setRemote', description.type])
    }

    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:client-answer\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' } }
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (url, { method, headers, body }) => {
    const type = new Headers(headers).get('Content-Type')
    calls.push([method, type, body])
    if (method === 'OPTIONS')
      return new Response(null, { status: 204 })
    if (method === 'POST')
      return new Response(counterOffer, { status: 406, headers: { 'Location': `${new URL(url).pathname}/session`, 'Content-Type': 'application/sdp' } })
    if (method === 'PATCH')
      return new Response(null, { status: 204 })
    return new Response(null, { status: 204 })
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push(`${error.type}:${error.httpStatus}`))
  await setImmediate()
  assert.ok(issuedPeer, JSON.stringify(calls))
  await setImmediate()
  assert.deepEqual(errors, [])
  assert.equal(player.state, 'running')
  const patches = calls.filter(([method]) => method === 'PATCH')
  assert.equal(patches.length, 1, JSON.stringify(calls))
  assert.equal(patches[0][1], 'application/sdp')
  // 反向 offer 之后，候选片段必须使用 answer 的 ICE 凭据与 mid 作用域。
  emitTrickle({ sdpMid: '0', candidate: 'candidate:after-answer' })
  await setImmediate()
  const trickles = calls.filter(([method, type]) => method === 'PATCH' && type === 'application/trickle-ice-sdpfrag')
  assert.equal(trickles.length, 1, JSON.stringify(calls))
  assert.match(trickles[0][2], /a=ice-ufrag:client-answer/)
  assert.doesNotMatch(trickles[0][2], /a=ice-ufrag:client\r\n/)
})
test('an expired counter-offer is refused without sending an answer', async (t) => {
  const calls = []
  const counterOffer = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:server\r\na=ice-pwd:server-pwd\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n'
  Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {} })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCSessionDescription'))
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:client\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' } }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:client-answer\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' } }
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (url, { method }) => {
    calls.push(method)
    if (method === 'OPTIONS')
      return new Response(null, { status: 204 })
    if (method === 'POST')
      return new Response(counterOffer, { status: 406, headers: { 'Location': `${new URL(url).pathname}/session`, 'Content-Type': 'application/sdp; valid-until="Thu, 01 Jan 1970 00:00:00 GMT"' } })
    return new Response(null, { status: 204 })
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push([error.type, error.phase]))
  await setImmediate()
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], 'SignalError')
  assert.equal(player.state, 'failed')
  assert.equal(calls.includes('PATCH'), false)
})

test('a 406 without a usable SDP still fails as an HTTP error', async (t) => {
  for (const headers of [{ Location: '/session' }, { 'Content-Type': 'application/sdp' }]) {
    for (const body of ['', 'not an sdp']) {
      await t.test(JSON.stringify(headers) + body, async (t) => {
        class Peer {
          addTransceiver() {}
          async createOffer() { return { type: 'offer', sdp: 'v=0\\r\\na=ice-ufrag:client\\r\\nm=video 9 UDP/RTP/SAVPF 96\\r\\na=mid:0\\r\\n' } }
          async setLocalDescription() {}
          close() {}
        }
        Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
        t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
        const calls = []
        t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
          calls.push(method)
          return method === 'OPTIONS'
            ? new Response(null, { status: 204 })
            : new Response(body, { status: 406, headers })
        })
        const player = new WebRTCWhep({
          url: 'https://player.example/a',
          container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
          lazyLoad: false,
        })
        t.after(() => player.close())
        const errors = []
        player.on('error', error => errors.push([error.type, error.phase, error.httpStatus]))
        await setImmediate()
        assert.deepEqual(errors, [['RequestError', 'signaling', 406]])
        await setImmediate()
        // 已登记的会话按关闭规则清理一次；断言关注的是没有发 PATCH。
        assert.deepEqual(calls.filter(method => method !== 'DELETE'), ['OPTIONS', 'POST'])
        assert.ok(calls.filter(method => method === 'DELETE').length <= 1)
        assert.equal(player.state, 'failed')
      })
    }
  }
})
test('an ICE restart PATCH accepts 200 and rotates the entity tag', async (t) => {
  let emitCandidate
  let patchResponse
  const fragments = []
  const tags = []
  Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {} })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCSessionDescription'))
  const sdp = 'v=0\r\na=ice-ufrag:session\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:camera\r\na=ice-ufrag:media\r\n'
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp } }
    async setLocalDescription() {}
    onicecandidate = null
    async setRemoteDescription() {
      emitCandidate = candidate => this.onicecandidate?.({ candidate })
      this.onicecandidate?.({ candidate: { sdpMid: 'camera', candidate: 'candidate:first' } })
    }

    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (url, { method, body, headers }) => {
    if (method === 'POST')
      return new Response(sdp, { status: 201, headers: { Location: `${new URL(url).pathname}/session`, ETag: '"gen-1"' } })
    if (method === 'PATCH') {
      fragments.push(body)
      tags.push(new Headers(headers).get('If-Match'))
      return fragments.length === 1 ? new Response(null, { status: 204 }) : patchResponse
    }
    return new Response(null, { status: 204 })
  })
  const diagnostics = []
  const errors = []
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    onDiagnostic: record => diagnostics.push(record),
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  player.on('error', error => errors.push(error.type))
  await setImmediate()
  assert.equal(fragments.length, 1)
  patchResponse = new Response('a=ice-ufrag:restarted\r\n', { status: 200, headers: { ETag: '"gen-2"' } })
  // 候选在等待上一次 PATCH 确认时缓冲，因此第二个请求仍携带旧 ETag。
  emitCandidate({ sdpMid: 'camera', candidate: 'candidate:second' })
  await setImmediate()
  assert.deepEqual(errors, [])
  assert.deepEqual(diagnostics, [])
  assert.equal(player.state, 'running')
  assert.equal(fragments.length, 2)
  patchResponse = new Response(null, { status: 204 })
  emitCandidate({ sdpMid: 'camera', candidate: 'candidate:third' })
  await setImmediate()
  assert.deepEqual(tags, ['"gen-1"', '"gen-1"', '"gen-2"'])
  assert.deepEqual(errors, [])
})

test('late PATCH completion cannot affect a replacement session', async (t) => {
  for (const status of [204, 404]) {
    await t.test(String(status), async (t) => {
      let peer
      let finishPatch
      const fragments = []
      const tags = []
      const authorizations = []
      let firstAnswer = true
      Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {} })
      t.after(() => Reflect.deleteProperty(globalThis, 'RTCSessionDescription'))
      const sdp = 'v=0\r\na=ice-ufrag:session\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:camera\r\na=ice-ufrag:media\r\n'
      class Peer {
        addTransceiver() {}
        async createOffer() { return { type: 'offer', sdp } }
        async setLocalDescription() {}
        async setRemoteDescription() {
          peer = this
          if (this.onicecandidate && firstAnswer) {
            firstAnswer = false
            this.onicecandidate({ candidate: { sdpMid: 'camera', candidate: 'candidate:early' } })
            this.onicecandidate({ candidate: { sdpMid: 'camera', candidate: '' } })
          }
        }

        close() {}
      }
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
      t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
      t.mock.method(globalThis, 'fetch', async (url, { method, body, headers }) => {
        if (method === 'POST')
          return new Response(sdp, { status: 201, headers: { Location: `${new URL(url).pathname}/session`, ETag: '"generation-a"' } })
        if (method === 'PATCH') {
          fragments.push(body)
          tags.push(new Headers(headers).get('If-Match'))
          authorizations.push(new Headers(headers).get('Authorization'))
          return new Promise((resolve) => {
            finishPatch = resolve
          })
        }
        return new Response(null, { status: 204 })
      })
      const diagnostics = []
      const retiredErrors = []
      const player = new WebRTCWhep({
        url: 'https://player.example/a',
        onDiagnostic: record => diagnostics.push(record),
        user: 'viewer',
        container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
        lazyLoad: false,
      })
      t.after(() => player.close())
      await setImmediate()
      assert.equal(fragments.length, 1)
      assert.deepEqual(authorizations, ['Basic dmlld2VyOg=='])
      assert.match(fragments[0], /a=candidate:early\r\na=end-of-candidates\r\n$/)
      finishPatch(new Response(null, { status: 204 }))
      await setImmediate()
      fragments.length = 0
      tags.length = 0
      player.removeAllListeners('candidate')
      const oldCandidate = peer.onicecandidate
      const oldTrack = peer.ontrack
      oldCandidate({ candidate: { sdpMid: 'unknown', sdpMLineIndex: 0, candidate: 'candidate:discard' } })
      await setImmediate()
      assert.equal(fragments.length, 0)
      oldCandidate({ candidate: { sdpMLineIndex: 0, candidate: 'candidate:test' } })
      assert.equal(typeof finishPatch, 'function')
      assert.deepEqual(tags, ['"generation-a"'])
      assert.match(fragments[0], /^a=ice-ufrag:session\r\nm=video 9 UDP\/TLS\/RTP\/SAVPF 96(?: \d+)*\r\na=mid:camera\r\na=ice-ufrag:media\r\na=candidate:test\r\n$/)
      const finishFirstPatch = finishPatch
      oldCandidate({ candidate: { sdpMid: 'camera', candidate: '' } })
      assert.equal(fragments.length, 1)
      finishFirstPatch(new Response(null, { status: 204 }))
      await setImmediate()
      assert.ok(fragments[1].endsWith('a=end-of-candidates\r\n'))
      oldCandidate({ candidate: { sdpMid: 'camera', candidate: 'candidate:queued-before-switch' } })
      assert.equal(fragments.length, 2)
      player.updateUrl('https://player.example/b')
      await setImmediate()
      const observeRetiredError = error => retiredErrors.push(error)
      player.on('error', observeRetiredError)
      finishPatch(new Response(null, { status }))
      await setImmediate()
      player.off('error', observeRetiredError)
      assert.deepEqual(retiredErrors, [])
      assert.deepEqual(diagnostics, [])
      assert.equal(fragments.length, 2)
      assert.equal(player.state, 'running')
      const candidates = []
      player.on('candidate', candidate => candidates.push(candidate))
      oldCandidate({ candidate: { sdpMLineIndex: 0, candidate: 'candidate:stale' } })
      assert.deepEqual(candidates, [])
      const tracks = []
      player.on('track', event => tracks.push(event))
      const staleStream = { getTracks: () => [{ kind: 'video' }] }
      oldTrack({ streams: [staleStream] })
      assert.deepEqual(tracks, [])
      const errors = []
      player.on('error', error => errors.push([player.state, error.phase, error.httpStatus]))
      t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
        if (method === 'PATCH')
          throw new TypeError('Private network detail')
        return new Response(null, { status: 204 })
      })
      player.on('candidate', () => {
        throw new Error('Observer failed')
      })
      assert.doesNotThrow(() => peer.onicecandidate({ candidate: { sdpMLineIndex: 0, candidate: 'candidate:current' } }))
      await setImmediate()
      assert.deepEqual(errors, [['failed', 'signaling', undefined]])
    })
  }
})

test('a signaling rejection reports one typed error after failing without retry', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    throw new TypeError('internal request detail')
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const findings = []
  player.on('error', error => findings.push([player.state, error.phase, error.message]))
  await setImmediate()
  assert.equal(requests, 1)
  assert.equal(player.state, 'failed')
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0].slice(0, 2), ['failed', 'signaling'])
  assert.ok(!findings[0][2].includes('internal request detail'))
})

test('ICE discovery ignores unrelated links and reads TURN credentials in any order', async (t) => {
  const peers = []
  class Peer {
    constructor({ iceServers }) { peers.push(iceServers) }
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    if (method !== 'OPTIONS')
      return new Promise(() => {})
    return new Response(null, { status: 204, headers: {
      Link: '<https://example.test/help>; rel="help",<turn:relay.example.test>; credential="fixture, value"; rel="ice-server"; credential-type=password; username="viewer"',
    } })
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  assert.deepEqual(peers.at(-1), [{ urls: ['turn:relay.example.test'], username: 'viewer', credential: 'fixture, value', credentialType: 'password' }])
})

test('ICE link parsing follows RFC 8288 and Chromium acceptance rules', async (t) => {
  const cases = [
    {
      name: 'anchored link is skipped',
      link: '<stun:anchored.example.test>; rel="ice-server"; anchor="https://elsewhere.test/",<stun:plain.example.test>; rel="ice-server"',
      expected: [{ urls: ['stun:plain.example.test'] }],
    },
    {
      name: 'case-insensitive relation and attribute names',
      link: '<turn:Case.example.test?transport=udp>; REL="ICE-Server"; UserName="viewer"; CREDENTIAL="secret"',
      expected: [{ urls: ['turn:Case.example.test?transport=udp'], username: 'viewer', credential: 'secret', credentialType: 'password' }],
    },
    {
      name: 'TURN without credentials is dropped',
      link: '<turn:noauth.example.test>; rel="ice-server",<stun:stun.example.test>; rel="ice-server"',
      expected: [{ urls: ['stun:stun.example.test'] }],
    },
    {
      name: 'duplicate rel keeps the first value only',
      link: '<stun:first.example.test>; rel="help"; rel="ice-server",<stun:second.example.test>; rel="ice-server"',
      expected: [{ urls: ['stun:second.example.test'] }],
    },
    {
      name: 'empty list elements are ignored',
      link: ',, <stun:only.example.test>; rel="ice-server",',
      expected: [{ urls: ['stun:only.example.test'] }],
    },
  ]
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const peers = []
      class Peer {
        constructor({ iceServers }) { peers.push(iceServers) }
        addTransceiver() {}
        async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
        async setLocalDescription() {}
        close() {}
      }
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
      t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
      t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
        if (method !== 'OPTIONS')
          return new Promise(() => {})
        return new Response(null, { status: 204, headers: { Link: item.link } })
      })
      const player = new WebRTCWhep({
        url: 'https://player.example/a',
        container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
        lazyLoad: false,
      })
      t.after(() => player.close())
      const errors = []
      player.on('error', error => errors.push(error.message))
      await setImmediate()
      assert.deepEqual(errors, [])
      assert.deepEqual(peers.at(-1), item.expected)
    })
  }
})

test('an unusable ICE server link is skipped instead of failing discovery', async (t) => {
  const peers = []
  class Peer {
    constructor({ iceServers }) { peers.push(iceServers) }
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }
    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    if (method !== 'OPTIONS')
      return new Promise(() => {})
    return new Response(null, { status: 204, headers: {
      Link: '<https://example.test/help>; rel="help",<nonsense>; rel="ice-server",<stun:stun.example.test:3478>; rel="ice-server"',
    } })
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push(error))
  await setImmediate()
  assert.deepEqual(errors, [])
  assert.deepEqual(peers.at(-1), [{ urls: ['stun:stun.example.test:3478'] }])
})

test('ice-server links with no usable URL still fail discovery once', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    if (method !== 'OPTIONS')
      return new Promise(() => {})
    return new Response(null, { status: 204, headers: { Link: '<nonsense>; rel="ice-server"' } })
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push([player.state, error.type, error.phase]))
  await setImmediate()
  assert.deepEqual(errors, [['failed', 'SignalError', 'signaling']])
})

test('failed ICE discovery preserves the HTTP status and stops signaling', async (t) => {
  for (const status of [400, 401, 403, 404, 406, 500, 503]) {
    await t.test(String(status), async (t) => {
      const methods = []
      t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
        methods.push(method)
        return new Response('Private upstream details', { status })
      })
      const player = new WebRTCWhep({
        url: 'https://player.example/a',
        container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
        lazyLoad: false,
      })
      t.after(() => player.close())
      const errors = []
      player.on('error', error => errors.push(error))
      await setImmediate()
      assert.deepEqual(methods, ['OPTIONS'])
      assert.deepEqual(errors.map(({ phase, httpStatus }) => [phase, httpStatus]), [['signaling', status]])
      // 草案 §4.1：播放器不得把状态码映射到具体原因，只回落通用类别。
      assert.equal(errors[0].type, ErrorTypes.REQUEST_ERROR)
      assert.equal(player.state, 'failed')
      assert.ok(!errors[0].message.includes('Private upstream details'))
    })
  }
})

test('source switches only reuse credentials on the initial origin', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, { headers }) => {
    requests.push([url, new Headers(headers).get('Authorization')])
    return new Promise(() => {})
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    token: 'fixture-token',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  player.updateUrl('https://other.example/b')
  player.updateUrl('https://player.example/c')
  assert.deepEqual(requests, [
    ['https://player.example/a', 'Bearer fixture-token'],
    ['https://other.example/b', null],
    ['https://player.example/c', 'Bearer fixture-token'],
  ])
})

test('an invalid initial endpoint fails before creating playback resources', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch')
  const create = () => new WebRTCWhep({
    url: 'file:///tmp/not-a-whep-endpoint',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  assert.throws(() => {
    const player = create()
    player.close()
  }, { phase: 'configuration' })
  assert.equal(fetch.mock.callCount(), 0)
})

test('an invalid source leaves the current request active', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    requests.push({ url, signal })
    return new Promise(() => {})
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push(error.phase))
  await setImmediate()
  player.updateUrl('not an absolute URL')
  assert.deepEqual(requests.map(({ url }) => url), ['https://player.example/a'])
  assert.equal(requests[0].signal.aborted, false)
  assert.equal(player.state, 'running')
  assert.deepEqual(errors, ['configuration'])
})

test('brief disconnection is ignored but persistent disconnection schedules recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.onconnectionstatechange)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  const change = (state) => {
    peer.connectionState = state
    peer.onconnectionstatechange()
  }
  const notifications = []
  player.on('state:change', ({ to }) => notifications.push(to))
  player.on('error', ({ phase }) => notifications.push(phase))
  player.on('restart', () => notifications.push('restart'))
  change('connected')
  change('disconnected')
  change('connected')
  t.mock.timers.tick(5000)
  assert.equal(player.state, 'running')
  change('disconnected')
  assert.equal(player.state, 'running')
  t.mock.timers.tick(5000)
  assert.equal(player.state, 'restarting')
  assert.deepEqual(notifications, ['restarting', 'connection', 'restart'])
  for (const delay of [2000, 4000, 8000]) {
    t.mock.timers.tick(delay)
    await setImmediate()
    change('connected')
    change('failed')
  }
  assert.equal(player.state, 'failed')
  assert.equal(notifications.filter(event => event === 'restart').length, 3)
})

test('confirmed video flow restores the first reconnect delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
  let peer
  let bytes = 0
  class Peer {
    async getStats() {
      return new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: ++bytes }]])
    }

    addTransceiver() {}
    async createOffer() {
      if (this.onconnectionstatechange)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  const change = (state) => {
    peer.connectionState = state
    peer.onconnectionstatechange()
  }
  change('connected')
  change('failed')
  t.mock.timers.tick(2000)
  await setImmediate()
  change('connected')
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.ok(bytes >= 2)
  change('failed')
  t.mock.timers.tick(2000)
  await setImmediate()
  assert.equal(player.state, 'running')
})

test('stats settling after peer retirement cannot reset the reconnect delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
  let peer
  let bytes = 0
  const delayed = Promise.withResolvers()
  const report = bytesReceived => new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived }]])
  class Peer {
    async getStats() {
      return ++bytes === 1 ? report(1) : delayed.promise
    }

    addTransceiver() {}
    async createOffer() {
      if (this.onconnectionstatechange)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  const change = (state) => {
    peer.connectionState = state
    peer.onconnectionstatechange()
  }
  change('connected')
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(bytes, 2)
  change('failed')
  t.mock.timers.tick(2000)
  await setImmediate()
  change('connected')
  delayed.resolve(report(10))
  await setImmediate()
  change('failed')
  t.mock.timers.tick(2000)
  assert.equal(player.state, 'restarting')
  t.mock.timers.tick(2000)
  assert.equal(player.state, 'running')
})

test('closing inside the restarting notification cancels recovery before later events', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.onconnectionstatechange)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const fetch = t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  const change = (state) => {
    peer.connectionState = state
    peer.onconnectionstatechange()
  }
  const events = []
  player.on('state:change', ({ to }) => {
    events.push(to)
    if (to === 'restarting')
      player.close()
  })
  player.on('state:change', ({ to }) => events.push(`second:${to}:${player.state}`))
  player.on('error', () => events.push('error'))
  player.on('restart', () => events.push('restart'))
  player.on('close', () => events.push('close'))
  const requests = fetch.mock.callCount()
  change('connected')
  change('failed')
  t.mock.timers.tick(10000)
  await setImmediate()
  assert.equal(player.state, 'closed')
  assert.equal(fetch.mock.callCount(), requests)
  assert.deepEqual(events, ['restarting', 'closed', 'second:closed:closed', 'close', 'second:restarting:closed'])
})

test('an explicit same-source update replaces pending automatic recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let peer
  class Peer {
    addTransceiver() {}
    async createOffer() {
      if (this.onconnectionstatechange)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const fetch = t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  const change = (state) => {
    peer.connectionState = state
    peer.onconnectionstatechange()
  }
  const requests = fetch.mock.callCount()
  change('connected')
  change('failed')
  assert.equal(player.state, 'restarting')
  player.updateUrl('https://player.example/a')
  await setImmediate()
  assert.equal(player.state, 'running')
  assert.equal(fetch.mock.callCount(), requests + 2)
  t.mock.timers.tick(2000)
  await setImmediate()
  assert.equal(fetch.mock.callCount(), requests + 2)
})

test('video codec probes use RTP encoding and clock rate instead of the public label', async (t) => {
  const offers = []
  const answers = []
  const postedOffers = []
  Object.defineProperty(globalThis, 'RTCSessionDescription', { configurable: true, value: class {
    constructor(init) { this.sdp = init.sdp }
  } })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCSessionDescription'))
  class Peer {
    addTransceiver(kind) { this.kind = kind }
    async createOffer() {
      return { sdp: `v=0\r\nm=${this.kind} 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:test\r\n` }
    }

    async setLocalDescription({ sdp }) { offers.push(sdp) }
    async setRemoteDescription({ sdp }) { answers.push(sdp) }
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (_url, { method, body }) => {
    if (method === 'OPTIONS')
      return new Response(null, { status: 204 })
    postedOffers.push(body)
    return new Promise(() => {})
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  for (const codec of ['H265', 'VP9', 'AV1'])
    assert.ok(offers.some(sdp => sdp.includes(` ${codec}/90000\r\n`)), codec)
  assert.equal(postedOffers.length, 1)
  assert.match(postedOffers[0], /multiopus\/48000\/7\r\na=fmtp:\d+ channel_mapping=0,4,1,2,3,5,6;num_streams=4;coupled_streams=3\r\n/)
  assert.match(postedOffers[0], /multiopus\/48000\/8\r\na=fmtp:\d+ channel_mapping=0,6,1,2,3,4,5,7;num_streams=5;coupled_streams=3\r\n/)
  const mediaLine = postedOffers[0].split('\r\n').find(line => line.startsWith('m=audio '))
  const payloadTypes = mediaLine.split(' ').slice(3).map(Number)
  assert.equal(payloadTypes.length, new Set(payloadTypes).size)
  assert.ok(payloadTypes.every(pt => pt >= 0 && pt <= 127 && (pt < 64 || pt > 95)))
  assert.equal(answers.length, 6)
  for (const answer of answers) {
    assert.match(answer, /a=mid:test\r\n/)
    assert.match(answer, /a=setup:active\r\n/)
  }
})

test('hung codec probes close before starting signaling without extensions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const open = new Set()
  class Peer {
    constructor() { open.add(this) }
    addTransceiver() {}
    createOffer() { return new Promise(() => {}) }
    close() { open.delete(this) }
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const results = []
  player.on('codecs:detected', result => results.push(result))
  assert.ok(open.size > 0)
  t.mock.timers.tick(3000)
  await setImmediate()
  assert.equal(open.size, 0)
  assert.equal(fetch.mock.callCount(), 1)
  assert.deepEqual(results, [[]])
})

test('a hung signaling request times out without a retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const fetch = t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal
    return new Promise(() => {})
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const errors = []
  player.on('error', error => errors.push(error))
  await setImmediate()
  t.mock.timers.tick(15000)
  assert.equal(player.state, 'failed')
  assert.equal(signal.aborted, true)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].phase, 'signaling')
  assert.match(errors[0].message, /timed out/i)
  assert.equal(errors[0].reason, 'setup-timeout')
  t.mock.timers.tick(15000)
  assert.equal(fetch.mock.callCount(), 1)
})

test('public notifications do not control the active session', async (t) => {
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  let restarts = 0
  player.on('restart', () => restarts++)
  player.emit('flow:stalled', { reason: 'No inbound video progress' })
  player.emit('error', new WebRTCError(ErrorTypes.OTHER_ERROR, 'External notification'))
  assert.equal(player.state, 'running')
  assert.equal(restarts, 0)
})

test('rejecting a URL update never reopens a closed player', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url)
    return new Response(null, { status: 204 })
  })
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  await setImmediate()
  player.close()
  const requestedBeforeUpdates = requests.length
  player.updateUrl('https://player.example/b')
  player.updateUrl('https://player.example/c')
  await setImmediate()
  assert.equal(player.state, 'closed')
  assert.equal(requests.length, requestedBeforeUpdates)
})

test('stats rejection reports a request-failed diagnostic instead of a stall', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000 })
  let peer
  const page = Object.assign(new EventTarget(), { hidden: false })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
  t.after(() => Reflect.deleteProperty(globalThis, 'document'))
  let failing = false
  class Peer {
    connectionState = 'connected'
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    getStats() {
      if (failing)
        return Promise.reject(new DOMException('Private stats detail', 'InvalidStateError'))
      return Promise.resolve(new Map())
    }

    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => method === 'POST' ? new Promise(() => {}) : new Response(null, { status: 204 }))
  const container = { srcObject: null, addEventListener() {}, removeEventListener() {} }
  const diagnostics = []
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false, onDiagnostic: record => diagnostics.push(record) })
  t.after(() => player.close())
  await setImmediate()
  peer.onconnectionstatechange()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  const stalls = []
  player.on('flow:stalled', event => stalls.push(event))
  failing = true
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(stalls.length, 0)
  assert.equal(player.state, 'running')
  assert.ok(diagnostics.length >= 1)
  const { playerId, attemptId, state, ...rest } = diagnostics.at(-1)
  assert.deepEqual(rest, { operation: 'sample-flow', phase: 'connection', reason: 'request-failed', elapsedMs: 0, cause: 'InvalidStateError' })
  assert.equal(attemptId, 1)
  assert.equal(state, 'running')
  assert.ok(Number.isInteger(playerId))
  assert.ok(!JSON.stringify(diagnostics).includes('Private stats detail'))
})

test('a rejected codec probe still starts playback detection with no extensions', async (t) => {
  class Peer {
    addTransceiver() {}
    createOffer() { throw new DOMException('Private probe detail', 'NotSupportedError') }
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
  })
  t.after(() => player.close())
  const results = []
  player.on('codecs:detected', result => results.push(result))
  await setImmediate()
  assert.deepEqual(results, [[]])
  assert.equal(fetch.mock.callCount(), 1)
})

test('steady flow sampling replaces the startup check instead of scheduling both', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000 })
  let peer
  let samples = 0
  const page = Object.assign(new EventTarget(), { hidden: false })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
  t.after(() => Reflect.deleteProperty(globalThis, 'document'))
  class Peer {
    connectionState = 'connected'
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    getStats() {
      samples++
      return Promise.resolve(new Map())
    }

    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => method === 'POST' ? new Promise(() => {}) : new Response(null, { status: 204 }))
  const player = new WebRTCWhep({ url: 'https://player.example/a', container: { srcObject: null, addEventListener() {}, removeEventListener() {} }, lazyLoad: false })
  t.after(() => player.close())
  await setImmediate()
  peer.onconnectionstatechange()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  for (let i = 0; i < 45; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  const startup = samples
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  const steady = samples - startup
  assert.ok(startup >= 6, startup)
  assert.ok(steady >= 1 && steady <= 3, steady)
})

test('transport failure cancels pending media recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let peer
  let plays = 0
  class Peer {
    connectionState = 'connected'
    addTransceiver() {}
    async createOffer() {
      if (this.ontrack)
        peer = this
      return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' }
    }

    async setLocalDescription() {}
    close() { this.connectionState = 'closed' }
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => method === 'POST' ? new Promise(() => {}) : Promise.resolve(new Response(null, { status: 204 })))
  const container = Object.assign(new EventTarget(), {
    srcObject: null,
    paused: true,
    muted: false,
    currentTime: 0,
    async play() {
      plays++
      this.paused = false
    },
  })
  const player = new WebRTCWhep({ url: 'https://player.example/a', container, lazyLoad: false })
  t.after(() => player.close())
  await setImmediate()
  const successes = []
  player.on('play:success', () => successes.push(plays))
  peer.onconnectionstatechange()
  peer.ontrack({ streams: [{ getTracks: () => [{ kind: 'video' }] }] })
  await setImmediate()
  assert.equal(plays, 1)
  container.error = { code: 3, message: 'Private decode detail' }
  container.dispatchEvent(new Event('error'))
  peer.connectionState = 'failed'
  peer.onconnectionstatechange()
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(plays, 1)
  assert.deepEqual(successes, [1])
})

test('an external abort during cleanup is reported as a request failure', async (t) => {
  const cleanupDeadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => cleanupDeadline.signal)
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n'
  class Peer {
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp } }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer })
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'))
  t.mock.method(globalThis, 'fetch', (_url, { method }) => {
    if (method === 'POST')
      return Promise.resolve(new Response(sdp, { status: 201, headers: { Location: '/session/a' } }))
    if (method === 'DELETE')
      return Promise.reject(new DOMException('Private abort detail', 'AbortError'))
    return Promise.resolve(new Response(null, { status: 204 }))
  })
  const diagnostics = []
  const player = new WebRTCWhep({
    url: 'https://player.example/a',
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
    lazyLoad: false,
    onDiagnostic: record => diagnostics.push(record),
  })
  await setImmediate()
  player.close()
  cleanupDeadline.abort(new DOMException('Private abort detail', 'AbortError'))
  await setImmediate()
  assert.equal(player.state, 'closed')
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].reason, 'request-failed')
  assert.equal(diagnostics[0].operation, 'delete-session')
  assert.ok(!JSON.stringify(diagnostics).includes('Private abort detail'))
})
