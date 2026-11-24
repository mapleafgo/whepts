# WHEP 草案 -05 客户端合规审查

基点 `c05d273`，2026-11-24。规范：[IETF Datatracker](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/)、[draft-ietf-wish-whep-05 正文](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-05)。这是 Internet-Draft，不是已发布 RFC。范围是 WhepTS 播放器，不把端点、服务端和 IANA 的义务算到客户端。结论：**不完全合规**。

| 条款 | 客户端结论与证据 |
|---|---|
| §4.1 HTTP | 通用请求错误保留 HTTP 状态，不按状态猜业务原因；[HTTP 层](../../src/core/http.ts#L64-L79)。端点 GET 返回空 2xx 是服务端职责。 |
| §4.2 HEAD 发现 | 可选；SDK 接收显式 URL，不凭非规范提示猜测，无缺项。 |
| §4.3、§4.3.1 初始 POST / 201 | JSEP offer、application/sdp POST、浏览器应用 answer 已实现。201 的 MIME/Location 要求属于端点；SDK 宽容接收，不能据此判定客户端违规。[HTTP 层](../../src/core/http.ts#L131-L179)。 |
| §4.3.2 反向 offer | PATCH SDP、等待 204、提交前检查明确期限已实现；缺省 30 秒从读完正文时起算，而草案从服务端发送时起算，慢传输条件待验证。[期限读取](../../src/core/http.ts#L18-L25)。 |
| §§4.3.3、4.3.5 406 / MIME / SDP | **Chrome 确认不合规**：application/sdpx 被当作 application/sdp，实际发送 PATCH 并播放。SDP 初筛也仅检查基本结构；其他无效报文和错误 Location 的副作用待验。[HTTP 分流](../../src/core/http.ts#L181-L192)。 |
| §4.3.4 部分媒体接受 | 由 JSEP 处理部分接受；至少保留一条 A/V、拒绝 m-line 的细节未做专项线验。 |
| §4.3.6 方向 | 初始音视频均 recvonly；反向 answer 依赖浏览器，额外 m-line 的方向未做专项线验。[连接层](../../src/core/connection.ts#L40-L48)。 |
| §§4.3.7–4.3.8 编解码与示例 | 使用浏览器能力和探测，符合尽量纳入支持编解码器的方向；示例非独立要求，不等同于保证任意设备支持 H.265。 |
| §4.3.9 会话等待 | 自动周期重试可选。Chrome 实测 409 + Retry-After: 10 后，调用方对同一 URL 显式 updateUrl，第二次 POST 只隔约 0.021 秒；这证明 SDK 不约束显式重试，不证明它会自行提前周期重试。[更新入口](../../src/whep.ts#L727)。 |
| §4.4 终止 / CORS | 有可读会话 URL 时发 DELETE；重定向夹具覆盖可读与不可读 Location 两类。服务端预检和资源释放不是客户端义务。[HTTP DELETE](../../src/core/http.ts#L200-L208)。 |
| §§4.5、4.5.1–4.5.2 Trickle / ETag | 已实现候选缓冲、批量 PATCH 和会话 ETag；max-bundle 未落实，不能保证片段只含规范预期的 BUNDLE tag m-line。缺失/不可见 ETag 的通配符策略与不同服务端组合待测。[候选请求](../../src/core/http.ts#L214-L237)。 |
| §§4.5.3、4.6.3 ICE 重启 | 原会话 ICE restart 是可选能力，目前是重建会话，不是原地 ICE restart；处理 200 仅更新 ETag，未应用返回的远端 ICE 信息，不能宣称支持 ICE restart。全量 ICE 委托浏览器。 |
| §4.6.1 BUNDLE / RTCP | **Chrome 线验不合规**：没有设置 max-bundle；实际 POST 的音视频 m-line 均为端口 9，无 bundle-only，两节都无 rtcp-mux-only。[Peer 配置](../../src/core/connection.ts#L40-L48)。能播放不等于满足此条款。 |
| §4.6.2 单媒体流 | 本地合并轨道不等于线上的单一 msid 与每种媒体最多一轨；对额外轨道未强制校验，异常拓扑待做专项线验。[轨道归并](../../src/core/track.ts#L85-L102)。 |
| §4.7 重定向 | POST 307 已做 Chrome 环回；PATCH/DELETE 不跟随属于草案许可。301/302 不得用于保持 POST 是服务端约束；503 的等待建议不等同于 §4.3.9 的 409 条款。 |
| §4.8 ICE 服务发现 | 读取 OPTIONS Link，允许显式覆盖；未消费 201 Link 属互通局限，不应将端点可选发送写成播放器无条件 MUST。[发现路径](../../src/core/http.ts#L115-L129)。 |
| §§4.9、4.9.1 认证 | 支持 Bearer，同源路径已验证；跨源不复送同一凭据（Fetch 和 SDK 的安全边界），不覆盖跨源会话要求独立鉴权的部署。Basic 兼容并优先于 token，与 §4.9.1 按字面要求的授权头策略存在差异，需单独确定配置契约。[认证路径](../../src/core/http.ts#L96-L112)。 |
| §4.10 扩展 | 不识别的扩展不影响主流程；服务端扩展广告与 IANA 注册是其他角色职责。 |
| §5 安全 | 草案要求 HTTPS；实现允许明文 HTTP 端点及会话，环回实测确实发送了明文请求。这是开发与局域网兼容取舍，不可计为严格合规。不能用浏览器混合内容限制代替 SDK 约束。 |
| §6 IANA | 注册表、URN 和扩展注册是其他角色职责。 |

## 复验

同一生产构建：Node 106 项、lint、TypeScript 检查通过；[反向 offer 浏览器夹具](../../tests/browser-counter-offer.py) 5 项通过，[重定向浏览器夹具](../../tests/browser-redirect.py) 3 个场景通过。另以 Chrome 和环回 HTTP 测了上述 MIME、SDP 线格式与显式 409 重试。没有覆盖所有浏览器、TURN 和真实服务端的所有组合。本轮未修改运行时代码。
