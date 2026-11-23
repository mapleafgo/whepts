# WHEP 播放器三个缺口：社区一手来源调研

> 过程记录：本文保留三个缺口的社区做法与规范原文；实施结果与回归见 [A6/A8 验收记录](2026-11-20-whepts-acceptance.md)。

> 范围：只使用一手来源——上游源码（GitHub raw，附行号）、W3C/WHATWG/IETF 规范、Node.js 官方文档。
> 标注约定：**【规范要求】** = 规范用 MUST/SHALL；**【规范允许】** = MAY/SHOULD/未作规定；**【实现惯例】** = 上游实现里的事实做法，规范未要求。
> 取源时间：2026-11-23。行号以取源时刻的文件为准；上游若改动，以函数名/代码片段为锚点重新定位。
> 本仓库现状引用均指向 `src/` 下的行号，仅作对照，不建议据此改动。

---

## 0. 结论摘要与推荐做法

### 问题一：宿主覆盖了 `video.srcObject` 后，播放器如何重新接管

| 要点 | 结论 | 性质 |
|---|---|---|
| 元素语义 | `srcObject` 的 setter 会设置 assigned media provider object 并**触发 media element load algorithm**（即一次 `load()`），加载过程中会 `fire an event named emptied` | 【规范要求】HTML |
| 检测手段 | 没有“元素被外部接管”这一类规范事件；可行三档：① 在主动驱动点比对 `element.srcObject !== ourStream`；② 监听 `emptied`（每次 `load()` 都会发）；③ 监听 `error`（已有） | 【规范允许】+【实现惯例】 |
| 是否需要 MutationObserver | **不需要**。`srcObject` 是 IDL 属性、不是 content attribute，`MutationObserver` 观察不到；只有宿主改的是 `src` attribute 时才可见 | 【规范要求】（DOM 的 mutation 观察对象是 attribute） |
| 恢复时机 | 在“我们下一次要驱动元素时”重挂：`play()` 前、`onTrack` 后、媒体错误恢复时、定时健康检查里。**不要**在检测到被覆盖的瞬间无条件回写 | 【实现惯例】 |
| 何时放弃 | 被覆盖 → 进入“外部接管态”：停止自己的 `play`/停滞判定，不 emit 失败/停滞，不重建会话；只有宿主先释放（`srcObject` 变回 `null` 或我们的流）才恢复。媒体元素 `error`/恢复失败仍走既有失败路径 | 【实现惯例】 |
| 最简可比对写法 | LiveKit `attachToElement`：先读 `element.srcObject instanceof MediaStream`，最后 `if (element.srcObject !== mediaStream) element.srcObject = mediaStream` —— 以“我算出的 stream 引用”为唯一真值 | 【实现惯例】 |

**推荐做法（本库）**

1. 保持单一真值：`TrackManager.stream`（已有）。所有判定写成 `element.srcObject === this.stream`，**不要**写成 `!element.srcObject`，也**不要**比较 `getTracks()` 内容（宿主可能把我们的 track 塞进他自己的流里）。
2. **主动时间点重挂（首选，零额外监听）**：若 `srcObject !== stream` 且当前未处于“外部接管态”，直接重挂并 `play()`。候选位置：
   - `syncPlayback()`（已有：`src/core/track.ts` 第 142 行）
   - `PlayMonitor.play()` 起始（已有：`src/monitors/play-monitor.ts` 第 63 行）
   - `recover()` 恢复前（已有：`src/monitors/play-monitor.ts` 第 222–229 行）
3. **被动检测（补足“两次驱动之间被换掉”）**：监听元素 `emptied`，把“上一次我们设置的 `srcObject` 引用”与当前值比对：
   - `srcObject === null` → 视为宿主主动卸载：等同 `paused`（与 `src/core/track.ts` 第 122 行 `paused` 定义一致），停停滞判定，**不报错**；
   - `srcObject` 是别的对象 → 进入外部接管态，停 `play`/`stalled` 判定并停顿，直到我们下次主动驱动时才退出该态并重挂。
   - `emptied` 是**必要不充分**：`networkState === NETWORK_EMPTY` 时后续 `load()` 不再发；故**以时间点比对为主，`emptied` 只用于提前降噪**。
4. **不要用 MutationObserver**：`srcObject` 观察不到；`src` attribute 可以观察到，但那是“宿主换源”，与本缺口不是同一问题。
5. **不要自动回写**：立即回写会与宿主（例如同时管理 `<video src>` 与 WebRTC 的外壳）互抢，表现为 `play()` 被反复 `AbortError`。LiveKit 也只在“调用方主动 attach”时回写，不做后台抢占。

### 问题二：事件监听器抛错时库应如何暴露而不互相干扰

| 要点 | 结论 | 性质 |
|---|---|---|
| 同一 target 内多监听器 | DOM 的 inner invoke 对每个 listener 单独调用；抛出时只 Report exception 并**继续下一个 listener** | 【规范要求】DOM |
| 谁负责报告 | 由 UA 报告到该 listener 所属 realm 的 global；`dispatchEvent` **不向调用方抛出**监听器异常 | 【规范要求】DOM |
| 唯一例外 | `legacyOutputDidListenersThrowFlag`——**仅 Indexed Database API 使用**；库自定义事件没有这个通道 | 【规范要求】DOM |
| Node EventEmitter | 监听器同步抛错会向 `emit` 调用方抛出；`error` 事件无监听者时 throw 并终止进程；`events.errorMonitor` 可“不消费错误”地旁路观察 | 【规范要求】Node 文档（非 Web 规范） |
| eventemitter3 | `emit` **不捕获**监听器异常：异常冒泡给调用方，且**中断后续监听器** | 【实现惯例】（源码无 try/catch） |
| Shaka | `EventManager` 只做绑定簿记、无 try/catch；公开事件走 `dispatchEvent`，即采用规范的“报告但不中断”语义 | 【实现惯例】 |
| hls.js | `event-listener-helper` 只做去重绑定、无 try/catch；错误走结构化 `Events.ERROR`（ErrorData/`fatal`）数据通道 | 【实现惯例】 |
| Video.js | 本轮未取得可核对的一手代码位置，**不作结论**（见 §2.6） | — |

**推荐做法（本库）**

1. **一个监听器抛错不得影响其它监听器**：本库用 eventemitter3，`emit` 遇抛错会中断后续监听器——与 DOM 语义**实质偏差**。应对齐 DOM：自行遍历 listener、逐个隔离。
2. **异常不得静默**：不要 `catch {}`；至少留一条可观测通道。仿 Node 的 `events.errorMonitor` 设计——**旁路观察器不消费错误**：新增 `onListenerError?: (info) => void`，或复用 `onDiagnostic`，把 `{ event, errorName }` 送出去；`console.warn` 只作兜底。
3. **不要把监听器异常塞进公开的 `error` 事件**：否则消费者的 bug 会被误判成播放失败，可能触发错误的重连逻辑。用独立诊断通道。
4. **不要复制 `error` 的“无监听即抛”语义**：那是 Node 为逼迫处理错误而设；浏览器库抛到 window 只会污染宿主页面。
5. **区分“没监听者”（本库自身缺陷，开发期断言）与“监听者抛错”（外部 bug，走诊断）**。

### 问题三：Trickle ICE 的 PATCH 挂起（服务端不返回）

| 要点 | 结论 | 性质 |
|---|---|---|
| PATCH 响应契约 | 仅追加候选 → **204 且不带 ETag**；ICE restart → **200 + 新 ETag + 监听器分片** | 【规范要求】WHEP draft-05 §4.5.1 / §4.5.3 |
| 幂等性 | WHEP PATCH **没有**幂等键或去重语义；仅对 ICE restart 定义“按最后一次请求的响应为准”的逻辑顺序规则 | 【未规定】/【规范要求】(顺序) |
| 重试 | 草案只在两处提重试：① POST 遇 409 + `Retry-After` 的**有界重试**（MUST NOT 早于 Retry-After）；② ICE restart PATCH 失败后 **MAY 重试或 DELETE**。**普通候选 PATCH 的超时/重试完全未规定** | 【规范要求】(409) / 【规范允许】(ICE restart) / 【未规定】(候选 PATCH) |
| ETag 失配 | 缺失 → **428 Precondition Required**；不匹配 → **412 Precondition Failed** | 【规范要求】§4.4.1 引 RFC 9110 §13.1.1 / RFC 6585 §3 |
| 候选合并 | WHEP **不支持** SDP 重协商；ICE restart 后双方 MUST 用新集合**替换**旧候选 | 【规范要求】§4.5.3 |
| 重复发送候选 | 草案允许排除“已被确认”的候选 ⇒ 重复发送不是协议违例（服务端静默丢弃） | 【规范允许】§4.5.2 |
| MediaMTX 客户端 | `fetch` 无超时；**任何一次**候选 PATCH 失败 → 关 PC、DELETE、2s 后整会话重启；逐候选 PATCH，不聚合 | 【实现惯例】 |
| MediaMTX 服务端 | 单 goroutine 串行消费候选通道；处理器无单请求时限，只受 10s 握手 / 2s 轨道收集约束 | 【实现惯例】 |
| Janus 客户端 | 通用封装**有** `options.timeout`（`Promise.race`），但 trickle **不传 timeout**；失败只 `Janus.error`，不重建 | 【实现惯例】 |
| LiveKit 客户端 | 候选走信令 protobuf `trickle`，**无单候选超时**；只有房间级 connect/ping 超时 | 【实现惯例】 |
| 参考实现 whip-whep-js | `patch()` 无超时/无 AbortController；失败直接抛；只保证“单在途 + ICE restart 成功后才继续” | 【实现惯例】 |

**推荐做法（本库）**

1. **以 RFC 8838 边界为准**：一旦发出 end-of-candidates，**不再** trickle；需要新候选只能走 ICE restart（RFC 8838 §13）。
2. **PATCH 加独立超时（建议 5s），但超时≠会话失败**：
   - 超时/网络错误 → 丢弃该批、记诊断（`operation: 'trickle-ice'`, `reason: 'timeout'`）、**继续下一批**；
   - **412/428** → 用最近一次成功的 ETag 重发一次；仍失败则停止 trickle，记诊断；
   - **404** → 会话已不存在，此时才允许放弃候选并重建；
   - **405/501** → 服务端不支持 PATCH，退化为 `complete` 语义。
3. **不要“放弃后续候选”**：草案要求服务端“静默丢弃不支持的候选并继续处理请求其余部分”，客户端应对称，只丢失败的那一批。
4. **不要因候选 PATCH 失败重建会话**：那是 MediaMTX 参考页面的简化策略，代价是一次完整握手；只在 ICE 状态确实 `failed`/`disconnected` 超过宽限期时重建。
5. **串行 + 聚合**：一个在途 PATCH；草案 SHOULD 在拿到 201 后聚合发送首批候选。
6. **ICE restart 乱序**：客户端 MUST 丢弃旧 ufrag/pwd，并**忽略任何在途旧 PATCH 的响应**，只应用“最后发出的那个请求”的响应（§4.5.3）——这直接影响现有 `flushCandidates` 的写法。

---

## 1. 问题一：元素被外部接管

### 1.1 规范面：`srcObject` 的语义与副作用

**WHATWG HTML — HTMLMediaElement**

> The `srcObject` getter steps are to return this's **assigned media provider object**. The `srcObject` setter steps are: **Set this's assigned media provider object to the given value.** **Invoke this's media element load algorithm.**
>
> There are three ways to specify a media resource: the `srcObject` IDL attribute, the `src` content attribute, and `source` elements. **The IDL attribute takes priority**, followed by the content attribute, followed by the elements.
>
> —— https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject

- **【规范要求】** 给 `srcObject` 赋值 ⇒ 重跑加载算法（等价于一次 `load()`），且 `srcObject` 优先于 `src` attribute。**“恢复”最省事的做法就是再赋一次值**——语义上是一次全新加载。
- **【规范要求】** 加载算法在 `networkState !== NETWORK_EMPTY` 时会 fire an event named `emptied`，并把 `paused` 置 true、以 `AbortError` reject 所有 pending play promise。见 https://html.spec.whatwg.org/multipage/media.html#media-element-load-algorithm
- **【规范允许】** 最佳实践：用完释放媒体元素——`src` 置空；若用 `srcObject` 则置 `null`。见 https://html.spec.whatwg.org/multipage/media.html#best-practices-for-authors-using-media-elements 。含义：**`srcObject === null` 是合法的“宿主主动卸载”，不应当成错误**。

**W3C WebRTC 1.0**

- **【规范允许】** 规范自带示例只做判空，属于**反例级**写法：

```js
pc.ontrack = ({track, streams}) => {
  track.onunmute = () => {
    // don't set srcObject again if it is already set.
    if (remoteView.srcObject) return;
    remoteView.srcObject = streams[0];
  };
};
```

  出处：https://www.w3.org/TR/webrtc/ （simple peer-to-peer example）。注意 `if (remoteView.srcObject) return` 会让“宿主换成另一个流”永远得不到修复。
- **【未规定】** WebRTC 规范对如何接管/恢复媒体元素零规定，全部推给 HTML。

### 1.2 检测手段：能用什么，不能用什么

| 手段 | 可见性 | 结论 |
|---|---|---|
| 读 `element.srcObject` 与我们的 stream 比对 | 任何时候 | **可靠且唯一真值**；缺点：只在我们主动驱动的时刻检查 |
| `emptied` 事件 | 每次 `load()` 都发（含宿主覆盖 `srcObject`） | **必要不充分**：`networkState === NETWORK_EMPTY` 时后续 `load()` 不再发 |
| `loadstart` | 每次资源加载开始 | 会被“无资源”路径漏掉，且我们自己的重挂也触发，易自激 |
| `error`（`MEDIA_ERR_*`） | 真正的解码/网络错误 | 与“接管”无关，别混用 |
| `MutationObserver` 观察属性 | 只能看到 **DOM attribute**（`src`、`class`…） | **看不到 `srcObject`**（IDL 属性不产生 mutation record） |
| `Object.defineProperty` 劫持 `srcObject` | 可以 | **不要**：污染宿主页面，且多数宿主也用 IDL 访问 |

**证据（DOM 标准）**：`MutationObserver` 的观察目标定义为 attribute 变更记录（`attributeName`/`oldValue`）；IDL 属性赋值不产生 mutation record。
—— https://dom.spec.whatwg.org/#interface-mutationobserver

**证据（HTML spec）**：`srcObject` 在 IDL 中写作 `attribute MediaProvider? srcObject;`，**没有** `[Reflect]`（对比同接口 `[CEReactions, ReflectURL] attribute USVString src;`），因此不会反射到 content attribute。
—— https://html.spec.whatwg.org/multipage/media.html#htmlmediaelement

### 1.3 上游实现怎么做的

#### MediaMTX —— `internal/servers/webrtc/reader.js`（main）

- 库本身**完全不碰**媒体元素：`Conf` 只有 `url/user/pass/token/onError/onTrack/onDataChannel`（第 19–28 行）；`#onTrack` 只转发给 `onTrack`（第 663–667 行）。
- 演示页一次性赋值、无任何恢复：

```js
onTrack: (evt) => { setMessage(""); video.srcObject = evt.streams[0]; }
```

  出处：https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/read_index.html#L96-L99
- 结论：**【实现惯例】= 不做**。库不持有 `stream` 引用，也就无从检测。

#### Janus —— `html/demos/janus.js`（master）

- 只有两个“设一次”的原语，**无比对、无事件监听**：

```js
Janus.attachMediaStream = function(element, stream) {
  try { element.srcObject = stream; }
  catch (e) { try { element.src = URL.createObjectURL(stream); } catch (e) { Janus.error("Error attaching stream to element", e); } }
};
Janus.reattachMediaStream = function(to, from) {
  try { to.srcObject = from.srcObject; }   // 直接取“另一个元素”的当前值
  catch (e) { try { to.src = from.src; } catch (e) { Janus.error("Error reattaching stream to element", e); } }
};
```

  出处：https://github.com/meetecho/janus-gateway/blob/master/html/demos/janus.js#L465-L488
- `reattachMediaStream` 的语义值得注意：**以另一个元素当前持有的 `srcObject` 为准**——重挂由调用方决定，库不猜。
- 演示页同样一次性赋值：`Janus.attachMediaStream($('#remotevideo' + mid).get(0), stream);` —— https://github.com/meetecho/janus-gateway/blob/master/html/demos/streaming.js#L250
- 结论：**【实现惯例】= 不检测、不回写**，只提供“设置/从别处复制”两个原语。

#### LiveKit —— `client-sdk-js`（main）· 最有参考价值

- 统一 `attachToElement`：先读当前值、复用流引用，最后才在引用不等时赋值：

```ts
export function attachToElement(track: MediaStreamTrack, element: HTMLMediaElement) {
  let mediaStream: MediaStream;
  if (element.srcObject instanceof MediaStream) { mediaStream = element.srcObject; }
  else { mediaStream = new MediaStream(); }
  // ...
  // avoid flicker
  if (element.srcObject !== mediaStream) {
    element.srcObject = mediaStream;
    // ...
  }
}
```

  出处：https://github.com/livekit/client-sdk-js/blob/main/src/room/track/Track.ts#L385-L440
- 在 `attach()` 中显式处理“被外部改掉”：

```ts
// even if we believe it's already attached to the element, it's possible
// the element's srcObject was set to something else out of band.
// we'll want to re-attach it in that case
attachToElement(this.mediaStreamTrack, element);
```

  出处：https://github.com/livekit/client-sdk-js/blob/main/src/room/track/Track.ts#L174-L177
  即：LiveKit **只在“被要求 attach”时**做接管恢复，**没有**后台轮询、**没有** `emptied` 监听、**没有** MutationObserver。
- `detachTrack` 只动“自己那份”：`if (element.srcObject instanceof MediaStream) { ...; if (mediaStream.getTracks().length > 0) element.srcObject = mediaStream; else element.srcObject = null; }` —— 同上文件第 443–460 行。
- 结论：**【实现惯例】= 调用时重挂 + 引用比对**；检测由调用时机提供，不用事件。

#### WHEP 参考实现 —— medooze `whip-whep-js`（main）

- `WHEPClient` 完全不接触媒体元素：构造函数只初始化 ICE 状态（第 13–27 行），`view(pc, url, token)` 只操作 `RTCPeerConnection`。
  出处：https://github.com/medooze/whip-whep-js/blob/main/whep.js#L13-L29
- 结论：**【实现惯例】= 库不管**。

#### Shaka Player

- 走 MSE：`lib/media/media_source_engine.js` 与 `lib/media/video_wrapper.js` 中**均无 `srcObject` 字样**（全文检索为空），Shaka 不设置 `srcObject`。
  出处：https://github.com/shaka-project/shaka-player/blob/main/lib/media/media_source_engine.js 、https://github.com/shaka-project/shaka-player/blob/main/lib/media/video_wrapper.js
- 因此不存在“被覆盖 `srcObject`”的问题；它的等价检测是监听元素 `emptied`/`error`（见 hls.js 一节）。
- 结论：**不可直接借鉴**，但侧面说明 `emptied` 是元素被重载的通用可观测信号。

#### hls.js —— 最接近的等价场景（元素级接管）

- 绑定 `emptied` 与 `error`：`addEventListener(media, 'emptied', this._onMediaEmptied); addEventListener(media, 'error', this._onMediaError);`
  出处：https://github.com/video-dev/hls.js/blob/master/src/controller/buffer-controller.ts#L345-L346
- 处理函数**引用比对 + 只上报不抢占**：

```ts
private _onMediaEmptied = () => {
  const { mediaSrc, _objectUrl } = this;
  if (mediaSrc !== _objectUrl) {
    this.error(
      `Media element src was set while attaching MediaSource (${_objectUrl} > ${mediaSrc})`,
    );
  }
};
```

  出处：https://github.com/video-dev/hls.js/blob/master/src/controller/buffer-controller.ts#L2069-L2076
- **最有价值的实证**：主流库在等价场景下的策略是“**检测到外部接管 → 报一条结构化错误（进 ErrorData，`details` 可达应用）→ 不自动回写**”。
- 结论：**【实现惯例】**。

#### Video.js

- 本轮未取得可核对的一手代码位置（`src/js/` 下 `player/tech/errors/utils/events` 路径探测无匹配），**不作结论**，以免给出无法核对的断言。

### 1.4 汇总对照表

| 项目 | 持有 stream 引用 | 检测方式 | 恢复方式 | 放弃条件 |
|---|---|---|---|---|
| MediaMTX reader.js | 否（只转发 `onTrack`） | 无 | 无（交给页面） | 不适用 |
| Janus janus.js | 否（原语式 API） | 无 | `attachMediaStream` / `reattachMediaStream` | 不适用 |
| LiveKit Track.ts | 是（`attachedElements`） | **调用时**读 `srcObject` 比对 | 引用不等则重设 | 未被调用就永不检测 |
| whip-whep-js | 否 | 无 | 无 | 不适用 |
| Shaka | 否（MSE） | 不适用 | 不适用 | 不适用 |
| hls.js | 是（`_objectUrl`） | `emptied` + 引用比对 | **不回写，只报错** | 报错后交应用 |

### 1.5 落地清单

1. **定义“外部接管态”**：进入条件 = `srcObject` 既不是 `null` 也不是我们的 `stream`。
2. **进入后必做**：停停滞计时器（避免误报 `play:stalled`）、不调用 `play()`、不触发“视频不可用/恢复”循环、保留 `stream` 与 track 监听。
3. **退出唯一入口**：在某个“主动驱动点”准备接管时退出——若 `srcObject` 已是 `null` 或已是我们的 `stream`，直接恢复正常流程；否则**先重挂**再退出。
4. **重挂的原子序列**：`srcObject = null` → `srcObject = stream` → `await play()`；捕获 `NotAllowedError`（autoplay 被拦）走既有分支。
5. **事件监听最小集**：`emptied`（检测）+ `error`（已有）。**不要** `loadstart`（我们自己的重挂也会触发）。
6. **诊断**：接管通过 `onDiagnostic`（或新事件 `element:takeover`）暴露，**不要**走 `error`/`play:failed`——宿主接管是合法行为，不是失败。
7. **与 `paused` 的三态关系**：现有 `get paused() { return this.container.srcObject === null }`（`src/core/track.ts` 第 121–123 行）隐含“`srcObject` 为 null = 已暂停”；接管态应是第三个状态，不要塞进 `paused`。

---

## 2. 问题二：监听器抛错的暴露

> 说明：User-Agent 向“reported exception”报告的具体通道不在本轮可核实范围内（抓取的 WHATWG `webappapis.html` 中未检索到该措辞），故本节只引用**已逐字核实**的 DOM 标准步骤。宁可少写一条，也不给无法核对的引用。

### 2.1 DOM 标准：dispatch 内的监听器异常

> **To inner invoke**, given an event `event`, a list of event listeners `listeners`, … :
> For each listener of `listeners`, whose removed is false: …
> **Call a user object's operation with listener's callback, "handleEvent", « event », and event's currentTarget attribute value. If this throws an exception `exception`: Report exception for listener's callback's corresponding JavaScript object's associated realm's global object. Set `legacyOutputDidListenersThrowFlag` if given.** The `legacyOutputDidListenersThrowFlag` is only used by Indexed Database API. [INDEXEDDB]
> Unset event's in passive listener flag. … If event's **stop immediate propagation flag** is set, then break.

—— https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke

| 问题 | 答案 | 依据 |
|---|---|---|
| 一个 listener 抛错，后续还会执行吗？ | **会**。异常只被 report，循环继续（除非 `stopImmediatePropagation`） | 【规范要求】 |
| 会抛给 `dispatchEvent()` 调用方吗？ | **不会**；唯一出口 `legacyOutputDidListenersThrowFlag` **仅供 IndexedDB** | 【规范要求】 |
| 库能知道“我的监听器抛错了”吗？ | 用自定义事件时**不能** | 【规范要求】 |
| 冒泡路径上多个 target？ | 每个 path item 各自 invoke，互不中断 | 【规范要求】https://dom.spec.whatwg.org/#concept-event-dispatch |

> 最关键一句：**“Report exception … Set legacyOutputDidListenersThrowFlag if given”** —— **报告 ≠ 抛出**，且唯一回传通道被限定给 IndexedDB。任何 JS 库用自己的 EventTarget 派发事件，**都无法**从 `dispatchEvent` 返回值得知监听器是否抛错。

### 2.2 Node.js：作为“另一种设计”的对照（官方文档）

> **Error events** — When an error occurs within an `EventEmitter` instance, the typical action is for an `'error'` event to be emitted. … If an `EventEmitter` **does not have at least one listener registered for the `'error'` event, and an `'error'` event is emitted, the error is thrown, a stack trace is printed, and the Node.js process exits.**
>
> It is possible to monitor `'error'` events **without consuming the emitted error** by installing a listener using the symbol `events.errorMonitor`.
>
> **EventTarget error handling** — When a registered event listener throws (or returns a Promise that rejects), by default the error is treated as an **uncaught exception on `process.nextTick()`**. … **Throwing within an event listener will not stop the other registered handlers from being invoked.** The `EventTarget` does not implement any special default handling for `'error'` type events like `EventEmitter`.

—— https://nodejs.org/api/events.html#error-events 、https://nodejs.org/api/events.html#eventtarget-error-handling

三条可迁移的设计原则：

1. **“不消费错误的旁路观察器”**（`errorMonitor`）：诊断通道不得改变错误本身的传播语义——这正是“暴露而不互相干扰”的正解。
2. **“监听器抛错不中断其它监听器”**：与 DOM 一致。
3. **“`error` 是特殊事件”**：仅在 Node 这类有进程生命周期的宿主成立，**不要**搬到浏览器库。

### 2.3 eventemitter3：本库正在用的实现

- `index.js` 全文**没有 `try`/`catch`**（全文检索仅命中第 16 行注释与第 60 行 `TypeError`）。出处：https://github.com/primus/eventemitter3/blob/master/index.js
- 结论：**【实现惯例】** `emit` 中监听器同步抛错会**直接冒泡给调用方**，且**后续监听器不执行**（循环被异常打断）。这与 DOM“报告但不中断”**语义不同**，而浏览器用户预期更接近 DOM。

### 2.4 Shaka Player

- `shaka.util.EventManager` 是绑定簿记层，**无 try/catch**；`listenOnce` 的 shim 只负责“先解绑、再调用原 listener”：

```js
listenOnce(target, type, listener, options) {
  const shim = (event) => {
    this.unlisten(target, type, shim);
    listener(event);          // ← 无 try/catch
  };
  this.listen(target, type, shim, options);
}
```

  出处：https://github.com/shaka-project/shaka-player/blob/main/lib/util/event_manager.js#L77-L86
- 公开事件经 `dispatchEvent` 派出，因此**遵循 2.1 的 DOM 语义**。
- 结论：**【实现惯例】= 交给平台，不自行捕获**。

### 2.5 hls.js

- `utils/event-listener-helper.ts` 只做去重绑定：`removeEventListener(el, type, listener); el.addEventListener(type, listener);` —— https://github.com/video-dev/hls.js/blob/master/src/utils/event-listener-helper.ts#L1-L16
- 诊断通道不是异常捕获，而是**结构化错误对象**：

```ts
public onErrorOut(event: Events.ERROR, data: ErrorData) {
  switch (data.errorAction?.action) { /* DoNothing | SendAlternateToPenaltyBox | RetryRequest */ }
  const flags = data.errorAction?.flags || 0;
  if (flags & ErrorActionFlags.ResetMediaSource) { this.hls.recoverMediaError(); }
  if (data.fatal) { this.hls.stopLoad(); return; }
}
```

  出处：https://github.com/video-dev/hls.js/blob/master/src/controller/error-controller.ts#L477-L506
- 结论：**【实现惯例】= 不捕获监听器异常；用可分类错误数据（`details`/`fatal`）作诊断通道**。

### 2.6 Video.js

- 未取得可核对的一手代码位置，**不作结论**。

### 2.7 落地清单

1. **对齐 DOM 的“不中断”**：`notify` 由“一次 `emit`”改为“逐个调用 listener 并隔离异常”，保证坏监听器不影响其它监听器与内部状态机。
2. **提供不消费错误的旁路通道**：仿 `events.errorMonitor`，新增 `onListenerError?: (info: { event: string, errorName: string }) => void`，与 `error` 事件**并列而非替代**。
3. **绝不**把监听器异常写进 `error` 事件 / `play:failed`。
4. **开发期可观测**：调试构建 `console.warn('[WhepTS] Listener threw', ...)`；生产构建保持静默（与现有 rollup 策略一致），但必须经 `onListenerError` 发出。
5. **内部模块间事件**（`ConnectionManager`/`TrackManager` → `WebRTCWhep`）抛错属本库自身缺陷：开发构建断言，不走用户侧诊断。

---

## 3. 问题三：Trickle PATCH 挂起

### 3.1 规范面：RFC 8838

- **【规范要求】结束信号之后**：

> an agent **MUST NOT** convey any more candidates after it has conveyed an end-of-candidates indication.
> Past that point, an agent **MUST NOT** trickle any new candidates within this ICE session. Therefore, adding new candidates to the negotiation is possible only through an ICE restart (see Section 15).

  出处：https://www.rfc-editor.org/rfc/rfc8838#section-13
- **【规范要求】收到 end-of-candidates 之后**：

> After an agent has received an end-of-candidates indication, it **MUST ignore** any newly received candidates for that data stream or data session.

  出处：https://www.rfc-editor.org/rfc/rfc8838#section-14
- **【规范要求】nomination 之后不得继续 trickle**：`in all cases, an agent MUST NOT trickle any new candidates within an ICE session after nomination of a candidate pair`（§13）。
- **【规范允许】后续交换/重启**：§15 —— https://www.rfc-editor.org/rfc/rfc8838#section-15
- **【未规定】**：RFC 8838 是 ICE 层规范，**不涉及 HTTP 传输层的超时/重试/幂等**，这层完全由 WHEP 草案定义。

### 3.2 规范面：WHEP 草案（draft-ietf-wish-whep-05，October 2026）

> 版本说明：datatracker 当前展示 **-05**（抓取于 2026-11-23）；引文均取自该版本。

**(a) 候选 PATCH 响应契约 —— 【规范要求】**

> When a WHEP session receives a PATCH request that adds new ICE candidates without performing an ICE restart, it **MUST return a "204 No Content" response without a body and MUST NOT include an ETag header** in the response. If the WHEP session does not support a candidate transport or is not able to resolve the connection address, it **MUST silently discard the candidate and continue processing the rest of the request normally**.

**(b) ETag / 条件请求 —— 【规范要求】**

> Missing or outdated ETags in the PATCH requests from WHEP players will be answered by WHEP sessions … with a **"428 Precondition Required"** response for a missing entity-tag, and a **"412 Precondition Failed"** response for a non-matching entity-tag.

**(c) 聚合与缓冲 —— 【规范允许 / SHOULD】**

> it **MUST wait and buffer** any gathered candidates until the "201 Created" HTTP response to the initial POST request is received. … the WHEP player **SHOULD send a single aggregated HTTP PATCH request** with all the buffered ICE candidates once the response is received.

**(d) ICE restart 乱序 —— 【规范要求】**

> when the client performs an ICE restart, it **MUST discard any previous ICE username and passwords fragments and ignore any further HTTP PATCH response received from a pending HTTP PATCH request**. WHEP players **MUST apply only the ICE information received in the response to the last sent request**. … it **MUST send a new ICE restart request** to the WHEP session.

**(e) ICE restart 失败后的重试 —— 【规范允许】**

> The WHEP player **MAY retry** performing a new ICE restart or terminate the session by issuing an HTTP DELETE request instead.

**(f) POST 的 409 重试 —— 【规范要求】**

> the WHEP player **MUST NOT send a new request before the time indicated by the "Retry-After" header** … has elapsed.

（a–f 均出自 https://datatracker.ietf.org/doc/draft-ietf-wish-whep/ 的 §4.4.1 / §4.5.1 / §4.5.2 / §4.5.3）

**(g) 规范未规定之处（明确记录）**：候选 PATCH **没有**幂等键（如 `Idempotency-Key`）或去重语义；**没有**服务端处理时限；**没有**客户端超时要求。因此“PATCH 挂起”的处置**完全属于实现自由**，这正是各实现差异极大的原因。

**(h) 与 RFC 8838 的衔接**：§4.5.2 允许“排除已被确认的候选”，等价于**允许重复发送**（服务端静默丢弃），这为“超时后重发”提供了规范层面的安全依据。

### 3.3 上游实现怎么做的

#### MediaMTX 客户端 —— `reader.js`

- **无超时**：`#sendLocalCandidates` 直接 `fetch(...).then(...).catch(...)`，全文无 `AbortController`/`AbortSignal.timeout`。
  出处：https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/reader.js#L619-L644
- **逐候选一次 PATCH**（不聚合），仅在“会话 URL 未就绪”时缓冲：

```js
#onLocalCandidate(evt) {
  if (this.#state !== "running") { return; }
  if (evt.candidate !== null) {
    if (this.#sessionUrl === null) { this.#queuedCandidates.push(evt.candidate); }
    else { this.#sendLocalCandidates([evt.candidate]); }
  }
}
```

  出处：https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/reader.js#L605-L617
- **任何 PATCH 失败 = 整会话重启**：`.catch((err) => { this.#handleError(err.toString()); });` —— 同上文件第 641–643 行；`#handleError` 关 PC、`DELETE`、清空候选、`#RETRY_PAUSE = 2000` 后重启（第 409–444 行）。
- 另注：`If-Match: "*"` 写死，不跟随 200 响应里的新 ETag。
- 结论：**【实现惯例】= 无超时、无重试、失败即重建**（参考页面级实现，非健壮性范例）。

#### MediaMTX 服务端 —— `internal/servers/webrtc`

- PATCH 处理器只做：校验 `Content-Type` → 解析分片 → 投递到会话 `chAddCandidates` → **同步等**结果 → 回 204/200 或错误。
  出处：https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/http_server.go#L271-L334
- 会话侧**单 goroutine** 串行消费，逐条 `pc.AddRemoteCandidate`，只有 `s.ctx.Done()` 才中断：

```go
func (s *session) readRemoteCandidates(offer []byte, pc *webrtc.PeerConnection) {
    remoteUfrag := parseOfferUfrag(offer)
    for {
        select {
        case req := <-s.chAddCandidates:
            // ufrag 变化 ⇒ ICE restart ⇒ CreateFullAnswer ⇒ 200 + 新 ETag
            // 否则 ⇒ addSessionCandidatesRes{} ⇒ 204
        case <-s.ctx.Done():
            return
        }
    }
}
```

  出处：https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/session.go#L675-L732
- **没有**单请求处理时限；会话只受 `whepHandshakeTimeout`（默认 10s）与 `whepTrackGatherTimeout`（默认 2s）约束：

```go
pconf.WHEPHandshakeTimeout = Duration(10 * time.Second)
pconf.WHEPTrackGatherTimeout = Duration(2 * time.Second)
```

  出处：https://github.com/bluenviron/mediamtx/blob/main/internal/conf/path.go#L289-L290 （默认值见第 403–404 行）
- **会话粘滞风险**：`readRemoteCandidates` 是单消费者，`addCandidates` 是“投递 + 等回复”的同步握手——若消费者卡在 `pc.AddRemoteCandidate`，**所有**后续 PATCH 都会排队挂起。这解释了“服务端不返回”的一种成因。
  出处：https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/session.go#L746-L757
- 结论：**【实现惯例】= 服务端无 PATCH 时限**。

#### Janus —— `html/demos/janus.js`

- 通用 HTTP 封装**有**超时能力（`options.timeout` + `Promise.race`）：

```js
if(options.timeout) {
  let timeout = new p(function(resolve, reject) {
    let timerId = setTimeout(function() {
      clearTimeout(timerId);
      return reject({message: 'Request timed out', timeout: options.timeout});
    }, options.timeout);
  });
  fetching = p.race([fetching, timeout]);
}
```

  出处：https://github.com/meetecho/janus-gateway/blob/master/html/demos/janus.js#L133-L147
- 但 **trickle 调用不传 timeout**，失败只记日志：

```js
function sendTrickleCandidate(handleId, candidate) {
  if(!connected) { Janus.warn("Is the server down? (connected=false)"); return; }
  // ...
  if(websockets) { ws.send(JSON.stringify(request)); return; }   // 无超时、无回执
  Janus.httpAPICall(server + "/" + sessionId + "/" + handleId, {
    verb: 'POST', /* ... */ error: function(textStatus, errorThrown) {
      Janus.error(textStatus + ":", errorThrown);  // FIXME
    }
  });
}
```

  出处：https://github.com/meetecho/janus-gateway/blob/master/html/demos/janus.js#L1629-L1668
- ICE 生命周期由 PC 状态驱动（`onicecandidate` 发候选、`onconnectionstatechange` 交插件），与 PATCH 成功与否解耦 —— 同上文件第 1933–1965 行。
- 结论：**【实现惯例】= 有超时基础设施但不用于 trickle；候选发送失败不重建，只记录；WS 路径无背压/无确认**。

#### LiveKit —— `client-sdk-js`

- 候选走**信令通道**（protobuf `TrickleRequest`），不是 HTTP PATCH：`sendIceCandidate(candidate, target) { … case: 'trickle', value: new TrickleRequest({...}) }` —— https://github.com/livekit/client-sdk-js/blob/main/src/api/SignalClient.ts#L816-L820 ；发送点 `this.pcManager.onIceCandidate = (candidate, target) => { this.client.sendIceCandidate(candidate, target); }` —— https://github.com/livekit/client-sdk-js/blob/main/src/room/RTCEngine.ts#L663-L665
- **无单候选确认/超时**；超时只有房间级（connect 超时、ping 超时），例如 `ConnectionError.timeout('room connection has timed out (signal)')` —— https://github.com/livekit/client-sdk-js/blob/main/src/api/SignalClient.ts#L509
- 反方向（服务端→客户端）候选在本地**排队**直到 remote description 就绪：

```ts
async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
  if (this.pc.remoteDescription && !this.restartingIce) { return this.pc.addIceCandidate(candidate); }
  this.iceLog.debug('queuing remote ICE candidate until remote description applied', {...});
  this.pendingCandidates.push(candidate);
}
```

  出处：https://github.com/livekit/client-sdk-js/blob/main/src/room/PCTransport.ts#L442-L450
- 结论：**【实现惯例】= 无单候选超时；靠整条信令链路健康度兜底**。

#### WHEP 参考实现 —— medooze `whip-whep-js`

- `patch()` **无超时**、无 AbortController，失败直接抛：

```js
const fetched = await fetch(this.resourceURL, { method: "PATCH", body: fragment, headers });
if (!fetched.ok && fetched.status !== 501 && fetched.status !== 405)
  throw new Error("Request rejected with status " + fetched.status)
```

  出处：https://github.com/medooze/whip-whep-js/blob/main/whep.js#L387-L393
- 并发防护：`iceTrickeTimeout` 节流；**只有 ICE restart 成功后才允许再次 patch**（`if (this.candidates.length || this.endOfcandidates) this.patch();`）—— 同上文件第 424–433 行。
- 允许 405/501（服务端不支持 PATCH）而不视为错误，与草案的宽容姿态一致。
- 结论：**【实现惯例】= 无超时、单在途、失败抛出交应用**。

### 3.4 本库现状对照（仅对照，不建议据此改动）

- 候选 PATCH 使用 `If-Match: session.etag || '*'`，接受 204/200：`src/core/http.ts` 第 158–177 行。
- `flushCandidates` 串行 while 循环，同一时刻只允许一个 drain（`candidateDrain === signal` 去重）；**失败即 `failSetup`**：`src/whep.ts` 第 396–423 行。
- 全会话有 15s `CONNECTION_TIMEOUT_MS` 兜底，但那是“首次连通的整体期限”，不针对单个 PATCH：`src/whep.ts` 第 14 行、第 283–295 行。
- 也就是说：PATCH 挂起时本库表现接近 MediaMTX（最终失败 → 清理 → 有界重连），而非 LiveKit（永不因此重建）。

### 3.5 落地清单

1. **每个候选 PATCH 加独立超时**（建议 5s，与 DELETE 的 5s 对称），用 `AbortSignal.timeout`；**超时不计入会话失败**。
2. **分级处置**：

| 响应 | 处置 |
|---|---|
| 204 | 成功，清空该批 |
| 200 | ICE restart 成功：更新 ETag + 用新远端候选集合**替换** |
| 412 / 428 | 用最新 ETag 重发一次；仍失败 → 停止 trickle，记诊断 |
| 404 | 会话失效 → 放弃候选并重建（此时才允许 `failSetup`） |
| 超时 / 网络错误 | 丢弃该批，记诊断，**继续**下一批 |
| 405 / 501 | 服务端不支持 PATCH → 退化到 `complete` 语义或停止 trickle |

3. **不要因单次失败丢弃“后续候选”**：草案要求服务端“静默丢弃不支持的候选并继续处理请求其余部分”，客户端应对称。
4. **重发是安全的**：草案允许排除“已被确认的候选”，等价于允许重复；服务端会静默去重。故“超时后重发该批”不是协议违例（但需次数上限，例如 1 次）。
5. **只应用最后一次 ICE restart 的响应**：略过晚到的旧 PATCH 响应；检测到 ufrag/pwd 不一致时主动发起新的 ICE restart（§4.5.3）。
6. **end-of-candidates 之后停止 trickle**：本库当前不发送 end-of-candidates；若将来发送，必须按 RFC 8838 §13 停止后续 trickle。
7. **诊断字段**：扩展 `onDiagnostic` 的 `operation`（如 `'trickle-ice'`），区分 `reason: 'timeout' | 'precondition-failed' | 'session-gone'`；**不要**带出远端响应体（保持 `src/core/http.ts` 第 38–41 行“取消响应体”的策略）。

---

## 4. 一手来源清单

### 规范 / 官方文档

| 来源 | 链接 | 用途 |
|---|---|---|
| WHATWG HTML — HTMLMediaElement | https://html.spec.whatwg.org/multipage/media.html | `srcObject` IDL 与 setter、load algorithm 与 `emptied`、释放最佳实践 |
| WHATWG DOM Standard | https://dom.spec.whatwg.org/ | §2.9 派发 / inner invoke 的监听器异常、`MutationObserver` 观察对象 |
| W3C WebRTC 1.0 | https://www.w3.org/TR/webrtc/ | `srcObject` 示例写法（反例）、无接管规定 |
| RFC 8838 (Trickle ICE) | https://www.rfc-editor.org/rfc/rfc8838 | §13/§14/§15 候选与 end-of-candidates 纪律 |
| WHEP draft-ietf-wish-whep-05 | https://datatracker.ietf.org/doc/draft-ietf-wish-whep/ | §4.4.1 ETag/412/428/409、§4.5.1/4.5.2/4.5.3 PATCH 与 ICE restart 乱序 |
| Node.js — Events | https://nodejs.org/api/events.html | `'error'` 与 `events.errorMonitor`、EventTarget error handling |

### 上游源码（main/master，行号见各节）

| 项目 | 文件 | 链接 |
|---|---|---|
| MediaMTX | `internal/servers/webrtc/reader.js` | https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/reader.js |
| MediaMTX | `internal/servers/webrtc/http_server.go` | https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/http_server.go |
| MediaMTX | `internal/servers/webrtc/session.go` | https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/session.go |
| MediaMTX | `internal/conf/path.go` | https://github.com/bluenviron/mediamtx/blob/main/internal/conf/path.go |
| MediaMTX | `internal/servers/webrtc/read_index.html` | https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/read_index.html |
| Janus | `html/demos/janus.js` | https://github.com/meetecho/janus-gateway/blob/master/html/demos/janus.js |
| Janus | `html/demos/streaming.js` | https://github.com/meetecho/janus-gateway/blob/master/html/demos/streaming.js |
| LiveKit | `src/room/track/Track.ts` | https://github.com/livekit/client-sdk-js/blob/main/src/room/track/Track.ts |
| LiveKit | `src/room/PCTransport.ts` | https://github.com/livekit/client-sdk-js/blob/main/src/room/PCTransport.ts |
| LiveKit | `src/api/SignalClient.ts` | https://github.com/livekit/client-sdk-js/blob/main/src/api/SignalClient.ts |
| LiveKit | `src/room/RTCEngine.ts` | https://github.com/livekit/client-sdk-js/blob/main/src/room/RTCEngine.ts |
| Shaka | `lib/util/event_manager.js` | https://github.com/shaka-project/shaka-player/blob/main/lib/util/event_manager.js |
| Shaka | `lib/media/media_source_engine.js`、`lib/media/video_wrapper.js` | https://github.com/shaka-project/shaka-player/blob/main/lib/media/ |
| hls.js | `src/controller/buffer-controller.ts` | https://github.com/video-dev/hls.js/blob/master/src/controller/buffer-controller.ts |
| hls.js | `src/controller/error-controller.ts` | https://github.com/video-dev/hls.js/blob/master/src/controller/error-controller.ts |
| hls.js | `src/utils/event-listener-helper.ts` | https://github.com/video-dev/hls.js/blob/master/src/utils/event-listener-helper.ts |
| eventemitter3 | `index.js` | https://github.com/primus/eventemitter3/blob/master/index.js |
| WHEP 参考实现 | `whep.js`（medooze/whip-whep-js） | https://github.com/medooze/whip-whep-js/blob/main/whep.js |

### 未能核实 / 未作结论

- **Video.js**：未取得 `src/js/` 下可核对的具体行号，问题一/问题二均未断言其行为。
- **millicast / Dolby JS SDK**：本轮未取得可公开访问的一手源码位置，未纳入结论。
- **WHATWG HTML “runtime script errors / report an exception”**：抓取的 `webappapis.html` 中未检索到 “reported exception” 字样，故 §2 仅引用 DOM 标准中已核实的步骤。
- **WHEP 草案版本**：datatracker 当前为 **-05**；升版后 §4.5.x 的 412/428 与 ICE restart 乱序条款最可能变动，引用时请核对版本号。
