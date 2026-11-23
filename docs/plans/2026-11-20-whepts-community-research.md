# WhepTS 审计后重构：社区与规范调研

> 过程记录：本文是 2026-11-20 的协议与社区调研，结论已并入[架构改造方案](2026-11-20-whepts-architecture-design.md)；保留原文作为依据与比较记录。

核验日期：2026-11-20（Asia/Shanghai）。本笔记区分草案要求、固定版本源码行为和重构建议；没有修改实现，也未运行跨浏览器或服务器互通测试。

## 1. 协议基线

- [IETF Datatracker](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/) 显示为 WISH 工作组的 Active Internet-Draft，最新修订日期 2026-10-12；拟定 RFC 状态为 Proposed Standard，工作组状态为 Submitted to IESG for Publication，IESG 状态为 AD Evaluation::Revised I-D Needed；本文固定到 [draft-ietf-wish-whep-05](https://www.ietf.org/archive/id/draft-ietf-wish-whep-05.html)，到期日 2027-04-14。**WHEP（播放/出流）仍是 Internet-Draft，不是 RFC**。[-03](https://www.ietf.org/archive/id/draft-ietf-wish-whep-03.txt) 与 [-04](https://www.ietf.org/archive/id/draft-ietf-wish-whep-04.txt) 是历史版本；[RFC 9725](https://www.rfc-editor.org/rfc/rfc9725.html) 是 WHIP（发布/入流），不能给 WHEP 背书。WHEP §4.8 确实引用了 WHIP 的 ICE server Link 表达形式。
- [RFC 8840 §4.4、§8、§9](https://www.rfc-editor.org/rfc/rfc8840.html#section-4.4) 定义 SIP 场景下的 Trickle ICE SDP fragment：ICE 凭据维持原 SDP 的会话/媒体作用域，使用伪 m= 行、a=mid、a=candidate，必要时带 a=end-of-candidates；§9.2 有 ABNF。不要把 SIP INFO 或 RFC 8840 的 ICE 代次处理直接套成 WHEP HTTP 规则；WHEP §4.5.3 明确把更新后的 ICE 凭据视作 restart。用非数字 MID 和非连续媒体索引做测试，不用索引猜 MID。

## 2. 实际方法与协议差异

MediaMTX 以正式标签 **v1.15.5** 为样本：[服务端处理](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/http_server.go#L126-L312)、[路由和预检](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/http_server.go#L337-L409)、[官方 reader](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/reader.js#L409-L546)。ZLMediaKit 以 **52c38f8aaddbed0991366ad2aa6917bc4147256e**（2026-11-19 UTC 的 master 快照，非发布标签）为样本：[WebApi.cpp](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8aaddbed0991366ad2aa6917bc4147256e/server/WebApi.cpp#L2210-L2277)、[HttpSession 方法分发和预检](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8aaddbed0991366ad2aa6917bc4147256e/src/Http/HttpSession.cpp#L68-L110)。

| 方法 | WHEP -05 | MediaMTX v1.15.5 | ZLMediaKit 固定提交 |
| --- | --- | --- | --- |
| OPTIONS | §4.4 要支持 CORS OPTIONS，200 响应宜有 Accept-Post: application/sdp；§4.8 描述可在 201 提供 ICE Link。不要把浏览器预检当 ICE 发现。 | 带 Access-Control-Request-Method 的预检直接 204；实际 endpoint OPTIONS 经过鉴权，204，暴露 Link；官方 reader 用 Basic/Bearer 主动做 ICE 发现，对状态不做判断。 | 通用 OPTIONS 200，允许列表无 PATCH，所读 handler 不返回 ICE Link。 |
| POST | §4.3：application/sdp offer → 201 SDP answer + Location；仅当 406 为 application/sdp 且正文是合法 SDP offer 才是反提议，向对应会话 PATCH application/sdp answer → 204，不是把所有 406 当断流或找不到。 | endpoint /路径/whep；要求 application/sdp，成功 201，带相对 Location、ETag: *、Accept-Patch、Link；所读路径未实现反提议流程，reader 只接受 201 建连。 | /index/api/whep 走 play，非空正文 → 201 SDP answer + 绝对 Location，含删除 id/token；协商异常为 406 text/plain，不是反提议。旧 /index/api/webrtc 则是 200 JSON（含 sdp/id/type），并非无 Location 的标准 WHEP。 |
| PATCH | §4.5：普通 trickle 用 application/trickle-ice-sdpfrag → 204；按所支持的 ICE 代次校验发送当前 ETag，缺失或不匹配分别 428/412；若支持 ICE restart，If-Match: * + 新凭据 → 200 fragment 和新 ETag。反提议的 SDP answer 是另一类 PATCH。 | 会话路由接受 trickle fragment，成功 204；此 handler 不检验 If-Match，也非草案 ICE restart 的 200 交换。reader 用 If-Match: * 且不带 Authorization。 | 所读 HTTP 分发表无 PATCH，预检也不允许；不应依赖 trickle。建议用有界的 ICE gathering 完成后 POST 的 profile，端到端验证。 |
| DELETE | §4.4：向初始 POST 返回的会话 URL 终止资源，不需要以 ETag 匹配 ICE 代次。服务器不得依赖 DELETE 必达，应按 ICE consent、DTLS/连接状态回收。 | 会话路径/secret 定位；成功 200。官方 reader 的[错误重试路径](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/reader.js#L340-L360)尝试无 auth DELETE，公开 [close()](https://github.com/bluenviron/mediamtx/blob/v1.15.5/internal/servers/webrtc/reader.js#L45-L55)只关 PC、清计时器；不可照抄为资源清理契约。 | /index/api/delete_webrtc?id=…&token=… 验证 DELETE 方法和 token；资源不存在 404、token 错 401、调用 safeShutdown 后 200。 |

### CORS、鉴权与重定向

- [Fetch CORS](https://fetch.spec.whatwg.org/#http-cors-protocol)、[预检](https://fetch.spec.whatwg.org/#cors-preflight-fetch)与[重定向](https://fetch.spec.whatwg.org/#http-redirect-fetch)：跨域时非简单方法/头和 application/sdp 涉及预检；浏览器生成的预检不应要求应用 Bearer/Basic。显式 OPTIONS 自己是实际请求，也可能触发预检。服务器须允许实际方法、Content-Type、If-Match 及显式 Authorization（后者不能靠允许头通配符），并在实际响应中暴露要读的 Location、ETag、Link、Accept-Patch（如使用 Retry-After 也显式暴露）。若使用跨域 cookie/credentials: include，验证准确 Origin 和 Allow-Credentials，不能以通配 Origin 替代。命令行看到头不等于页面脚本可读。
- MediaMTX POST 明确暴露 ETag/ID/Accept-Patch/Link/Location；[配置](https://github.com/bluenviron/mediamtx/blob/v1.15.5/mediamtx.yml#L382-L387)的 webrtcAllowOrigins 控制允许来源。ZLMediaKit 所读 OPTIONS 按允许来源回显 Origin 与请求头、允许 credentials；[通用实际响应](https://github.com/ZLMediaKit/ZLMediaKit/blob/52c38f8aaddbed0991366ad2aa6917bc4147256e/src/Http/HttpSession.cpp#L800-L810)加 Origin/Credentials/Vary，但该处和 WHEP handler 未见暴露 Location，故浏览器跨域可能见到 201/SDP 却读不到 Location；代理可能改变结果，不能据源码宣称所有部署均如此。
- 草案 §4.7 推荐 POST 用 307（禁止 301/302 用于该流程），不要求支持会话 PATCH/DELETE 重定向。Fetch 对 301/302 的 POST 和适用的 303 会改成 GET，307/308 保持方法；跨 origin 跳转会剥除 Authorization，不能把直连的认证结果外推到跳转。相对 Location 以最终响应 URL 为基准（不是原配置 URL）；单独验证会话 URL 的 scheme/origin，只向策略信任的目标发凭证，不手动恢复跨域跳转剥除的头。MediaMTX 所读 301 是静态页面补斜杠，不是 WHEP POST。ZLMediaKit 用请求 Host 和当前 SSL 状态拼绝对 URL，反代 TLS 终止时应实测地址是否外部可达；不要记录含删除 token 或 TURN 凭据的原始 URL/头。
- 草案 §4.9 要求支持 Bearer；配置 Bearer 时适用于 endpoint/session 请求（预检除外），也允许其他 HTTP 认证及 URL 凭证。MediaMTX reader 的 Basic 优先、只给 OPTIONS/POST 加头是特定实现，不是通用规则；ZLMediaKit 删除 token 与建立会话的播放鉴权不是一回事，本次未追完整播放插件鉴权链。建议按 endpoint/session 及可信 origin 绑定凭据，而非在公共 fetch helper 中盲加头。

### 无 Location：保留兼容，不伪造资源

[当前 WhepTS HTTP](../../src/core/http.ts#L28-L94)已接受 201 无 Location，按原配置 URL 解析相对头，把 404/406 同归流不存在，trickle 固定 If-Match: *。建议先保留现有无 Location 兼容行为并标记「只可播放、不可管理」，严格模式则报告协议错误；若有旧部署契约，由它选择完整 offer、超时和诊断策略。201 未见 Location 既可能是真缺失，也可能被 CORS 隐藏：页面不能仅凭 null 判因。**不要猜会话 URL，不要对 endpoint PATCH/DELETE，不要用 200 JSON 旧 API 冒充 WHEP，不要把缺 Location 单独归咎于目标服务器。** 若会话依赖 Trickle 而缺 URL，候选不可无限积压；已 POST 的情形不能无条件补发 POST（可能创建第二个会话）。

## 3. 生命周期与资源归属

- [W3C WebRTC Recommendation（2025-03-13）](https://www.w3.org/TR/2025/REC-webrtc-20250313/)：RTCPeerConnection.close() 关闭本地连接/传输，不替客户端做 HTTP DELETE；restartIce() 影响后续 offer/协商，不等于 WHEP ICE restart 已完成。处理 candidate 的空字符串（本代次结束）与 null（本次 gathering 全部结束），并支持 track 事件没有关联 stream 的情形。真正的 ICE restart 与删旧会话、建新 PC 的重连是两种能力。
- [HTML play/pause](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource)、[srcObject](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject)与[Media Capture track.stop](https://www.w3.org/TR/mediacapture-streams/#dom-mediastreamtrack-stop)：pause 只停元素播放；play 返回 Promise，自动播放拒绝不是连接故障；解绑 srcObject 不会替信令或 PC 清理会话；stop() 只处置 SDK 拥有的轨道，不处置调用方借入的轨道/元素。解绑时确认元素仍绑定本实例的流，避免旧会话擦掉新流。
- 类比而非协议信息：[hls.js v1.6.13](https://github.com/video-dev/hls.js/blob/v1.6.13/src/hls.ts#L430-L524)将 attach/detach、loadSource 与 destroy 分开；[stopLoad](https://github.com/video-dev/hls.js/blob/v1.6.13/src/hls.ts#L569-L586)只停止控制器加载。WhepTS 可分别定义播放暂停/可见性、停止/重连传输、终态 close；不直接移植 HLS 控制器。
- **建议的所有权**：每次连接尝试拥有不可变 endpoint/auth/策略快照、PC、abort controller、候选队列和可选会话 URL；每个播放器实例拥有公开监听、重试计时器、监控调度器和媒体绑定。换 URL、重试和 close 共享同一个幂等的会话清理：先作废尝试代次，再撤订阅/停止监控、关 PC、清候选；独立且有界地 DELETE 已知旧会话（不要复用已经 abort 的请求信号）。迟到的 201 不准安装到新会话；能看到旧 Location 时只清理旧资源；如果请求已在服务端创建但客户端没收到响应，只能依靠服务端回收。最终 close 才销毁实例级监听和调度器，旧 track/error/timer 一律不能恢复终态。

## 4. 测试与包发布验收建议（尚未执行）

| 层级 | 最少验证项 |
| --- | --- |
| 单元/控制时序 | 用可控 Fetch、PC、时钟和元素验证 201/406 两种 SDP 类型、JSON/纯文本错误、OPTIONS 200/204/鉴权失败、Link 解析；trickle 批量、MID、结束标记和 ETag 412/428；无 Location 不发送 PATCH/DELETE；close/updateUrl 与晚到 POST/PATCH、track/promise 交错时只关闭旧会话、不会复活、最多一次清理。 |
| HTTP 契约与真实浏览器 | 双 origin 测预检/实际 OPTIONS、同源和跨源 307/相对 Location、401/403、跨域 Authorization 丢弃以及 Location/ETag/Link 头隐藏与暴露；验证 406 text/plain 与反提议的区分，DELETE 200/204、404、网络丢失下的本地幂等。Mock 和 curl 不能证明浏览器 CORS。 |
| 固定服务器版本互通 | 在两套固定版本各推一路可控流，记录浏览器与代理配置、HTTP 方法/状态、脚本可读头和服务端会话数（脱敏）；MediaMTX 跑 trickle，ZLMediaKit 测全量候选与会话删除；验证禁自动播放、暂停/可见性不重建传输、切源后旧会话收敛。覆盖至少 Chromium/Firefox/WebKit，编码与 TURN 成功分列。 |
| 发布包 | 按 [TS 发布声明指南](https://www.typescriptlang.org/docs/handbook/declaration-files/publishing.html)、[TS 模块解析/exports](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports)、[npm CLI v11 package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json) 和 [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack)：当前 [manifest](../../package.json#L1-L38)是 ESM、main/types 指向 dist，未声明 exports/files。不必因重构强加 CJS；如引入 exports，先审计深路径兼容，保证 types 条件优先且指向实际产物，files 限定发布内容。用 npm pack --dry-run 检查文件清单、实际 tarball 在临时消费项目用 bundler 与 NodeNext 检验公共 import 与类型；确认声明无内部 ~/ 别名，不把仓库直接 import 当发布验证。 |

## 5. 核验范围与未决项

核对 Datatracker 状态及 -05 §§4.3–4.9（-03/-04 仅用于版本对照）、RFC 9725 的标题与引用范围、RFC 8840 §§4.4/8/9；核对 W3C WebRTC 2025 Recommendation、W3C Media Capture 的 track.stop 和 WHATWG Fetch/HTML 对应锚点。服务端与 SDK 结论仅及上述 tag/SHA 及引用函数，未枚举历史发行版。MediaMTX 官网的浏览器页面本次返回 403，采用同项目官方 reader/服务端与配置源码替代。TS Handbook、Fetch、HTML 为滚动文档；npm 按 CLI v11 引用。没有实测任一服务器、代理、浏览器或 npm 消费包；ZLMediaKit 旧版是否确实缺头、代理默认是否暴露头、鉴权插件配置、ICE gathering 超时与浏览器行为仍需按实际部署补证。此笔记不构成全草案符合性声明。
