import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import Player, { ErrorTypes } from "../dist/index.js";

const ENDPOINT = "https://example.test/whep";
const SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=ice-ufrag:test\r\na=ice-pwd:testpwd\r\n";

function fixture(t, respond) {
  const requests = [];
  const errors = [];
  class Peer {
    addTransceiver() {}
    async createOffer() {
      return { type: "offer", sdp: SDP };
    }
    async createAnswer() {
      return { type: "answer", sdp: SDP };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
    }
    async setRemoteDescription() {}
    close() {}
  }
  for (const [key, value] of [
    ["RTCPeerConnection", Peer],
    ["RTCSessionDescription", class {}],
  ]) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.mock.method(globalThis, "fetch", async (url, { method }) => {
    requests.push([String(url), method]);
    return method === "POST" ? respond(String(url)) : new Response(null, { status: 204 });
  });
  const player = new Player({
    url: ENDPOINT,
    lazyLoad: false,
    container: { srcObject: null, addEventListener() {}, removeEventListener() {} },
  });
  player.on("error", (error) => errors.push(error));
  t.after(() => player.close());
  return { player, errors, requests };
}

for (const [type, accepted] of [
  ["application/sdpx", false],
  ['Application/SDP; valid-until="Tue, 01 Jan 2030 00:00:00 GMT"', true],
]) {
  test("406 content type: " + type, async (t) => {
    const { requests, errors } = fixture(
      t,
      () =>
        new Response(SDP, {
          status: 406,
          headers: { "Content-Type": type, Location: "/session" },
        }),
    );
    await setImmediate();
    if (accepted) {
      assert.equal(errors.length, 0);
      assert.ok(requests.some(([, method]) => method === "PATCH"));
    } else {
      assert.deepEqual(
        requests.map(([, method]) => method),
        ["OPTIONS", "POST"],
      );
      assert.equal(errors[0]?.httpStatus, 406);
    }
  });
}

for (const header of ["10", "Tue, 14 Nov 2023 22:13:30 GMT"]) {
  test(
    "409 deadline blocks explicit same-endpoint retries without queuing: " + header,
    async (t) => {
      let now = 1700000000000;
      t.mock.method(Date, "now", () => now);
      let attempts = 0;
      const { player, requests, errors } = fixture(t, (url) => {
        if (url === ENDPOINT && attempts++ === 0)
          return new Response(null, { status: 409, headers: { "Retry-After": header } });
        return new Response(SDP, { status: 201 });
      });
      await setImmediate();
      player.updateUrl(ENDPOINT + "#ignored");
      await setImmediate();
      assert.deepEqual(
        requests.map(([, method]) => method),
        ["OPTIONS", "POST"],
      );
      assert.deepEqual(
        errors.map((error) => [error.type, error.phase, error.httpStatus, error.retryAt]),
        [
          [ErrorTypes.REQUEST_ERROR, "signaling", 409, now + 10000],
          [ErrorTypes.REQUEST_ERROR, "signaling", undefined, now + 10000],
        ],
      );
      const other = ENDPOINT + "?source=backup";
      player.updateUrl(other);
      await setImmediate();
      assert.deepEqual(requests.at(-1), [other, "POST"]);
      player.updateUrl(ENDPOINT);
      assert.equal(player.state, "running");
      assert.equal(errors.at(-1).retryAt, now + 10000);
      now += 10000;
      await setImmediate();
      assert.deepEqual(requests.at(-1), [other, "POST"]);
      player.updateUrl(ENDPOINT);
      await setImmediate();
      assert.deepEqual(requests.at(-1), [ENDPOINT, "POST"]);
    },
  );
}

for (const [status, header] of [
  [409, null],
  [409, "1.5"],
  [409, "0"],
  [503, "10"],
]) {
  test("no cooldown for " + status + " with Retry-After " + header, async (t) => {
    const { player, requests, errors } = fixture(
      t,
      () =>
        new Response(null, { status, headers: header === null ? {} : { "Retry-After": header } }),
    );
    await setImmediate();
    assert.equal(errors[0]?.retryAt, undefined);
    player.updateUrl(ENDPOINT);
    await setImmediate();
    assert.equal(requests.filter(([, method]) => method === "POST").length, 2);
  });
}
