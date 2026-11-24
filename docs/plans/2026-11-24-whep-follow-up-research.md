# WhepTS 三项复审调研

结论：三项均成立。本文基于草案与源码静态核对，未修改或运行产品测试，也未验证浏览器与服务端的反向 offer 互通。

## 1. 反向 answer PATCH 未确认时保留 15 秒总期限

- **协议依据：** [WHEP 草案 -03 §4.2.2–4.2.3](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-03#section-4.2.2) 要求客户端在收到带 SDP 的 406 后，向 Location 指向的会话资源发送 SDP answer（PATCH，application/sdp），成功由 204 确认。这是建立会话所需的信令，不是候选 PATCH。15 秒是 [WhepTS 自身的预算](../../src/whep.ts#L15)，不是草案要求。
- **现状：** [本地 answer 先应用到 Peer](../../src/core/connection.ts#L111-L135)，随后 [WhepTS 等待 answer PATCH](../../src/whep.ts#L596-L608)，[HTTP 层只接受 204](../../src/core/http.ts#L81-L94)。服务端可能已经应用 answer，但响应在返回途中迟滞；这时 [Peer 的 connected 事件](../../src/core/connection.ts#L174-L191) 会[无条件取消总计时器](../../src/whep.ts#L168-L171)。如果请求持续挂起，原有 [setup-timeout 出口](../../src/whep.ts#L353-L366) 就不会执行，answerApplied 仍为 false，候选队列也不会排空。
- **建议：** 在同一次仍有效的 attempt 中，等到信令完成 **且** 当前 Peer 已连通才取消原定时器，由两侧到达时都检查，不能只在其中一侧检查或再开一个 15 秒计时。反向路径以收到 204 为信令完成，正向路径以应用远端 answer 为完成；收到 204 后若仍在等 Peer，超时归 connection，等待 204 时归 signaling。若先连通后断开，不应把尚未建立的会话当作成功后的重连；超时沿用 [failSetup 与现有清理](../../src/whep.ts#L410-L434)，让 attempt abort，迟到的 204 不恢复旧会话。候选 PATCH 独立预算不变。
- **播放器对照：** [MediaMTX v1.15.5 官方浏览器 reader](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/reader.js#L399-L405) 把 HTTP 交换串在应用 answer 之前；[POST 只接受 201](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/reader.js#L459-L500)，[PATCH 发送的是候选片段](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/reader.js#L525-L545)。该版本仅作为正向流程的对照，不证明反向 PATCH、15 秒策略或本项目的实际互通。

## 2. off 省略 context 时匹配所有 context，仍应用 once 过滤

[EventEmitter3 5.0.4 的 removeListener](https://github.com/primus/eventemitter3/blob/5.0.4/index.js#L235-L270) 在单监听器和数组分支都按同一条件匹配：函数相同、once 为真时只删一次性监听器、context 为真时才按 context 严格匹配；[off 是别名](https://github.com/primus/eventemitter3/blob/5.0.4/index.js#L292-L295)。所以省略 context 或显式 undefined 是通配，once 为 false 或省略均不筛模式，不是“只删常驻”。上游实际上把其他假值 context 也视作通配；若要完整兼容，应单独核对 wrapper 的注册和绑定语义，不把精确 Map key 当成上游的有效 context。

WhepTS [按原函数、事件、context、注册模式索引包装函数](../../src/whep.ts#L472-L500)，但 [removeListener 只取 .get(context)](../../src/whep.ts#L504-L534)，省略 context 时只查 undefined 桶；回退到原函数也匹配不到其他桶中的包装函数。建议通配时枚举同一事件、原函数下的所有 context，逐个移除匹配模式的包装函数；显式对象 context 仍隔离。保留 EventEmitter3 [自动移除已触发的 once 包装函数](https://github.com/primus/eventemitter3/blob/5.0.4/index.js#L155-L188) 的路径，不误删常驻、其他函数或其他事件。

## 3. 反向 offer 本地过期错误归 signaling

[WHEP 草案 -03 §4.2.2](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-03#section-4.2.2) 把 valid-until 定义为 Content-Type 里的 HTTP-date；未提供时从服务端发出响应起有效 30 秒。[WhepTS 的缺省实现](../../src/core/http.ts#L18-L25) 从本地解析时刻估算 30 秒；这和 15 秒本地尝试预算是两件事，此次不建议顺带改解析。

[两次有效性检查](../../src/whep.ts#L583-L605) 分别在生成 answer 前、生成后且发 PATCH 前，过期时都抛 SignalError 并标成 signaling。然而 [connect 进入分支前把 progress.phase 置为 connection，catch 又只取 progress.phase](../../src/whep.ts#L398-L407)；[failSetup 以传入阶段重建公开错误](../../src/whep.ts#L410-L434)，所以实际抛给调用方的是 SignalError + connection（消息为 “Peer connection failed”）。建议在失败汇合处优先保留已明确标注的 WebRTCError.phase，未标注才用 progress.phase，或仅在有效性检查处明确切阶段；不要把真正在 Peer 上发生的操作异常也归为 signaling。客户端过期不发 PATCH，也没有该次 PATCH 的 HTTP 状态；服务端若实际返回非 204，则维持 RequestError + signaling 与原 httpStatus，不由状态码推断过期（[草案 §4.1](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-03#section-4.1)）。

## 后续验收建议（未执行）

- 先 connected、PATCH 持续挂起：原始第 15 秒报一次 signaling / setup-timeout 并清理；再覆盖 connected 与 204 的两种顺序、204 后尚未连通、timeout 后迟到 204，以及关闭或切源后旧回调不干扰新尝试。
- 同一函数在默认 context、A、B 各注册 on 和 once；核对 off(event, fn)、off(event, fn, undefined, true)、off(event, fn, A) 和 removeListener 别名，验证保留项与 once 触发后的自动移除。
- 让反向 offer 在生成 answer 前过期、以及生成期间过期：两者均不发 answer PATCH，只报一次 SignalError / signaling；另以 Peer 异常及实际 PATCH 非 204 作为分类对照。
