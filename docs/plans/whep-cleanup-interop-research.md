# WHEP 会话清理互通研究

> 本文保留时序与 CORS 的历史对照。当前实现和最终专项复验见 [A4 验收记录](2026-11-20-whepts-acceptance.md)：已分离的旧连接等待 DELETE 结算或 5 秒期限；ZLMediaKit 通过测试代理暴露 Location 的正对照和不暴露的负对照均已复验。

范围：MediaMTX **v1.15.5**、ZLMediaKit **52c38f8**（镜像锁定见[验收记录：39](2026-11-20-whepts-acceptance.md#L39)）。清理验收要分别回答：浏览器是否发出 DELETE、HTTP 返回什么、服务端是否释放会话。本地关闭与这三项也应分别判断。

## 草案和 Fetch

- [WHEP Internet-Draft -04 §4.2.1](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-04#section-4.2.1)：正常答复为 201、SDP answer 和指向新会话的 Location。[§4.4](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-04#section-4.4) 要求播放器显式结束时向初始 POST 提供的会话 URL 发 DELETE，并要求 WHEP 端点支持 CORS OPTIONS；草案没有把 404 定义成成功，也未要求等待 HTTP 响应再关闭本地 PeerConnection。[§4.3](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-04#section-4.3) 另区分 consent freshness 检测非正常断开和 DTLS teardown。
- Fetch 的 [CORS 响应头白名单](https://fetch.spec.whatwg.org/#cors-safelisted-response-header-name) 不含 Location 或 ETag。跨源 201 和 SDP 可被页面使用，DevTools 能看见的 Location 却可被 Fetch 过滤。应在**最终 POST 响应**明确返回 `Access-Control-Expose-Headers: Location`；通配符仅在凭据模式不是 `include` 时生效（[Fetch 暴露规则](https://fetch.spec.whatwg.org/#http-access-control-expose-headers)）。OPTIONS 允许 DELETE 不等于暴露 POST Location。
- DELETE 不是 [CORS 简单方法](https://fetch.spec.whatwg.org/#cors-safelisted-method)。无预检缓存命中时，跨源 [OPTIONS 预检](https://fetch.spec.whatwg.org/#cors-preflight-fetch-0) 发往会话 URL，不是只检查创建端点。显式 Authorization 必须列在 Allow-Headers；凭据模式为 `include` 时须明确允许页面 Origin 且返回 `Access-Control-Allow-Credentials: true`。[实际 DELETE 响应也须通过 CORS](https://fetch.spec.whatwg.org/#concept-cors-check)：预检失败可能未发 DELETE；实际响应被阻止时，服务端仍可能已经处理。curl 的 HTTP 结果不能替代浏览器证据。
- 重定向后的相对 Location 以最终 POST 响应 URL 为基准，保留地址查询串。[Fetch 重定向算法](https://fetch.spec.whatwg.org/#http-redirect-fetch) 保留 307 的 POST 方法，跨源跳转移除 Authorization；后续 DELETE 是新请求，不应向不同源转发入口鉴权。

## MediaMTX v1.15.5：正确会话地址也可能返回 404

**固定版源码。** [会话 Location](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/http_server.go#L57-L68) 为 `/<path>/whep/<secret>` 并保留查询参数；[POST 201](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/http_server.go#L233-L247) 暴露 Location 和 ETag。[路由分派](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/http_server.go#L374-L393) 将 DELETE 送到 WHIP/WHEP 共用的 [onWHIPDelete](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/http_server.go#L292-L315)：UUID 非法返回 400，`ErrSessionNotFound` 返回 404，命中返回 200。该 DELETE 处理器未检查 If-Match。

[服务端循环](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/server.go#L370-L398) 的 `chCloseSession` 移除会话和 secret 索引；`chDeleteSession` 按 secret 查找并核对路径，命中则移除索引并调用 `Close()` 取消上下文。[runRead](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/session.go#L376-L394) 监听 `pc.Failed()` 和会话取消，分别可返回 `peer connection closed` 和 `terminated`；[run](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/session.go#L101-L111) 通知父服务并记录关闭原因。200 不是等待所有底层对象析构的屏障。

**历史实测。** [验收记录：31–37](2026-11-20-whepts-acceptance.md#L31-L37)：Chrome 可读 Location/ETag；保持播放手动向同一 Location DELETE 得 200，随后播放器再次 DELETE 得 404。没有手动 DELETE 的双流对照中，本地关闭、解绑通过；播放器向已登记的地址发出的两次 DELETE 均为 404，服务端日志确认两会话因 PeerConnection 关闭回收；末次 404 发出 `delete-session` / `http-error` 诊断，播放器保持 `closed`。手动 200 不是播放器关闭验收。

**本次补充实测。** 当前[清理顺序](../../src/whep.ts#L145-L180) 取出并清除旧会话，使用独立信号先发起 DELETE，随后同步关闭本地 PeerConnection，不等 HTTP。本次用[同一 Chrome 双流脚本](../../tests/browser-mediamtx.py) 补跑一次，切流和末次关闭各收到 DELETE 200，服务端两个会话均记录 `closed: terminated`。

**推断。** 两组实测与源码共同支持关闭竞态：服务端先处理会话退出并移除索引，正确 DELETE 仍可能 404；DELETE 先命中则返回 200 并取消会话。404 单独不能证明原因，路径不匹配等也会 404；已有独立回收证据也不能把它归为 HTTP 成功。JS 先调用 Fetch 不保证网络到达或服务端处理先于传输关闭，一次双流 200 不能证明竞态消失。保留同步本地关闭、独立超时和非 2xx 诊断，不要等待 DELETE 才解绑或把 404 静默视作成功。

## ZLMediaKit 52c38f8：有 DELETE 处理器，但默认跨源页面读不到 Location

**固定版源码。** [创建及删除处理器](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8/server/WebApi.cpp#L2233-L2277)：`/index/api/whep` 创建播放会话，201 中返回 SDP 和绝对 Location；它以连接是否 TLS 及请求 Host 构造 `/index/api/delete_webrtc` 的地址，查询参数是经编码的传输 `id` 和逐会话删除 `token`。删除处理器要求两参数与原始方法 DELETE，找不到传输返回 404，token 不符返回 401，匹配则 `safeShutdown`（原因 `deleted by http api`）并返回 200。HTTP 层[把 DELETE 分派给 onHttpRequest_POST](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8/src/Http/HttpSession.cpp#L91-L103)，但该函数[仅触发 API 事件](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8/src/Http/HttpSession.cpp#L945-L947)，未把方法改成 POST。不要向创建 URL 发 DELETE，也不要从流名或 SDP 猜地址。

[OPTIONS](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8/src/Http/HttpSession.cpp#L68-L89) 对允许的 Origin 回显 Origin 和请求头，方法列表含 DELETE、不含 PATCH；[实际响应公共 CORS 头](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8/src/Http/HttpSession.cpp#L799-L810) 不暴露 Location，创建处理器也没额外暴露或生成 ETag。

**本仓实测。** [验收记录：39–57](2026-11-20-whepts-acceptance.md#L39-L57) 与 [Chrome 双流脚本](../../tests/browser-zlm.py)：使用正确监听端口 28091 和全量 ICE，两路均 OPTIONS 200、POST 201；原始响应有 Location，无 ETag 和 Expose-Headers，页面读不到 Location，未发 PATCH 或 DELETE。切流和本地关闭通过，服务端记录两个会话收到 DTLS close notify 后 transport shutdown，但未独立核对会话对象最终释放。此前端口 18091 的 POST 404 来自 llama.cpp，不是 ZLMediaKit 证据。真实跨源 307 播放通过，最终 Location 仍不可读。

**推断及部署方向。** 记录说明“浏览器没有发送 DELETE”，并非“服务端不支持 DELETE”或“清理已通过”。可对受信页面 Origin 在最终 201 明确暴露 Location，或用同源代理同时处理创建与删除路径。如果代理终止 TLS 或改写 Host，要确认 Location 的 scheme/host 是公开可达地址，必要时改写并原样保留编码查询串。不要把逐会话 token 或完整 Location 放进共享日志。暴露 Location 后还须验证目标 URL、预检、实际响应及服务端释放。

## 后续验收

1. **MediaMTX：**保留活会话手动 DELETE 对照，在冷预检缓存及不同 HTTP 延迟下反复比较先发 DELETE（不等待）与先关 PC；关联同一会话的浏览器预检/DELETE、HTTP 状态及服务端关闭原因。即使确认回收，404 仍记为 HTTP 非成功。
2. **ZLMediaKit：**保留未暴露 Location 的负对照；再在同源或跨源暴露部署中用还在播放的自有会话验证实际路由，再用不同会话验证切流及关闭。分别记录页面可读地址、实际 DELETE 状态、服务端关闭原因和会话对象移除证据；OPTIONS、curl 200 或 transport shutdown 单独不算浏览器清理完成。
3. **重定向：**[验收记录：57–59](2026-11-20-whepts-acceptance.md#L57-L59) 区分真实 ZLMediaKit 307 播放与 [Chrome 环回夹具](../../tests/browser-redirect.py) 的相对 Location、同/跨源 Bearer 边界和 DELETE 204。真正的服务端仍需补测最终可读的相对 Location、正确 DELETE 目标和回收证据。
