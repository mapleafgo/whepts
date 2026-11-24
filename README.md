# WhepTS Player

WhepTS 是浏览器中的单源 WebRTC WHEP 播放器。播放器管理连接、媒体挂载与清理；调用方负责选择地址、凭据和备用流。

## 快速开始

```bash
npm i whepts
```

页面提供 `<video id="video" playsinline></video>` 和 `<button id="resume" hidden>播放</button>`。

```typescript
import WebRTCWhep from "whepts";

const container = document.querySelector<HTMLVideoElement>("#video");
const resume = document.querySelector<HTMLButtonElement>("#resume");
if (!container || !resume) throw new Error("Missing video or play button");

const player = new WebRTCWhep({ url: "https://media.example.com/live/whep", container });

player.on("play:failed", ({ code, reason }) => {
  if (code === "autoplay-blocked") resume.hidden = false;
  else console.warn(reason);
});
player.on("error", ({ type, phase, httpStatus, message }) => {
  console.error(type, phase, httpStatus, message);
});
resume.addEventListener("click", () => player.resume());
```

页面或组件卸载时调用 `player.close()`，并移除调用方自己注册的 DOM 监听器。播放器不会自动静音；若希望静音播放，由调用方设置媒体元素。

## 配置

| 字段 | 用途 |
| --- | --- |
| `url` | 绝对 HTTP(S) WHEP 地址，不允许内嵌用户名或密码；非法初始地址同步抛出 `WebRTCError`。 |
| `container` | 借用的媒体元素；同一元素只交给一个活跃播放器。 |
| `user` / `pass` | 可选 Basic 认证。配置用户名时优先于 Bearer。 |
| `token` | 可选 Bearer 令牌。凭据不随 `updateUrl()` 转发到其他来源。 |
| `iceServers` | 可选 ICE 服务器；非空列表替代 OPTIONS 发现。 |
| `iceMode` | 默认 `trickle`；`complete` 等待 ICE 收集完成后发送完整 offer，不发候选 PATCH。适用于不支持 Trickle ICE 的部署。 |
| `lazyLoad` | 默认 `true`。至少 50% 可见才挂载播放，隐藏时保持传输。 |

## 浏览器兼容性

使用浏览器的**最新稳定版，并安装最新小版本更新**。较早版本不在兼容承诺内；实际验证范围见[验收记录](docs/plans/2026-11-20-whepts-acceptance.md)。H.265（HEVC）的 WebRTC 协商和实际解码还取决于浏览器、操作系统及设备；最新版不代表一定可播。面向未知客户端时，建议由服务端另行提供 H.264 流供调用方选择。

## 服务端接入

- **MediaMTX**：端点形如 `http://localhost:8889/live/whep`，使用默认的 `trickle`。
- **ZLMediaKit**：端点形如 `https://media.example.com/index/api/whep?app=live&stream=camera`，不支持 Trickle ICE 的部署使用 `iceMode: 'complete'`。

跨域部署须允许实际用到的方法和请求头，并在最终 POST 响应中暴露 `Location`（Trickle ICE 如使用 `ETag`，也应暴露）。会话地址本身也须允许跨域 DELETE。缺少可读地址时，播放器不猜测 PATCH 或 DELETE 的目标。`Link` 的 ICE 服务器按 RFC 8288 逐条解析：不可用地址、带 `anchor` 且无法重设锚点的链接、缺 `username`/`credential` 的 TURN 地址都会被跳过（Chromium 遇到这些会整体失败）。只有当响应声明了 ICE 服务器却一条可用都没有时才报告建连失败。部署对照及实测范围见[验收记录](docs/plans/2026-11-20-whepts-acceptance.md)。

## 播放控制与状态

- `pause()` / `resume()`：停止或恢复播放，不重建连接；手动暂停不因可见性变化而解除。
- `updateUrl(url)`：用有效的新地址替换当前连接；同地址表示显式重试，非法地址通过 `error` 报告且保留当前连接。跨来源新地址需要不同凭据时，关闭旧实例后用新配置构造实例。
- `close()`：终态，重复调用无额外副作用。立即停止播放并解绑媒体，不等待远端确认。已登记会话时，后台发送一次 DELETE，旧 PeerConnection 在请求结束或 5 秒期限到达时关闭；无会话地址则立即关闭连接。
- `state`：`getting_codecs`、`running`、`restarting`、`failed` 或 `closed`。`running` 表示已启动连接尝试，不代表连通或已出首帧。
- `paused`：反映媒体元素当前是否没有挂载源，不是传输状态。

候选 PATCH 失败或超过 5 秒未返回时，播放器只丢弃该批候选并通过 `diagnostic` 事件（`operation: "trickle-ice"`） 上报，会话与播放不受影响；后续候选仍会继续发送。这是有意与部分服务端参考实现（失败即整会话重启）不同的取舍。

播放器使用浏览器原生 `max-bundle`。播放器可断线后重建 WHEP 会话，但不支持在原会话内执行 ICE 重启。服务端用 `406 Not Acceptable` + `application/sdp` + 合法 offer 发反向 offer（草案 §4.3.2）时，播放器生成 answer 并用 `PATCH application/sdp` 提交，期望 `204`；其余 406 按 HTTP 错误处理。

首次建连失败由调用方决定是否重试。收到 `409` 且有可读、有效的 `Retry-After` 时，`error.retryAt` 给出可重试的 Unix 时间戳（毫秒）；同一实例在期限内显式重试该端点会立即报错，不发请求、不排队，也不限制切换到其他端点。跨源部署需通过 `Access-Control-Expose-Headers` 暴露 `Retry-After`。已连通的传输明确失败后，播放器可有限重连同一来源；不会自动切备用流。流量和播放停滞仅通知，不触发重连。

## 事件

| 事件 | 含义 |
| --- | --- |
| `codecs:detected` | 检测到的扩展编解码器列表。 |
| `state:change` | `{ from, to }` 状态变化。 |
| `candidate`、`track` | 浏览器原生 ICE 候选和轨道事件。 |
| `play:success` | `play()` 成功，包含 `muted`；不保证首帧已显示。 |
| `play:failed` | `{ code, reason, muted }`。原因码为 `autoplay-blocked`、`video-unavailable`、`element-recovery-exhausted` 或 `playback-error`；不要解析英文说明来决定流程。 |
| `play:stalled`、`flow:stalled` | 观察到播放或流量停滞，包含英文 `reason`。 |
| `error` | `WebRTCError`，使用 `type` 分类；`phase` 和 `httpStatus` 在适用时提供；建连超时带有 `reason: 'setup-timeout'`。 |
| `diagnostic` | `WhepDiagnostic`，用于观测脱敏的运行异常。 |
| `restart`、`close` | 已安排同源重连、本地关闭完成。 |

监听器语义与 DOM 事件派发一致：同一个事件的通知按注册时的快照依次调用，派发不等待监听器返回的 Promise。监听器同步抛错或返回的 Promise 被拒绝，都不会中断其余监听器或让播放失败；非诊断监听器的异常通过 `diagnostic` 事件上报，`operation` 为 `listener-error`。监听器内调用 `close()` 或 `updateUrl()` 时，已经开始的派发仍会完成，之后的旧通知被抑制。`on`、`once`、`addListener` 与 `off`、`removeListener` 使用同一份注册表，第三个参数 `context` 决定监听器内的 `this`。

当前导出的 `ErrorTypes` 包含 `SIGNAL_ERROR`、`STATE_ERROR`、`REQUEST_ERROR`、`NOT_FOUND_ERROR`、`VIDEO_ERROR` 和 `OTHER_ERROR`。HTTP 失败统一使用 `REQUEST_ERROR`，具体状态码由 `httpStatus` 表达；草案 §4.1 要求播放器不把状态码映射到具体原因。`NOT_FOUND_ERROR` 仅为保持导出兼容而保留。

## 诊断

使用 `player.on("diagnostic", handler)` 订阅 `WhepDiagnostic`。该事件覆盖四类脱敏事件：`delete-session`（远端会话清理失败）、`sample-flow`（统计采样超时或被拒绝）、`trickle-ice`（候选 PATCH 超时或失败）、`listener-error`（非诊断监听器抛错）。每条诊断包含 `playerId`、派发时的 `state`、`operation` 和 `reason`；有对应尝试时提供 `attemptId`，有 HTTP 错误状态时提供 `httpStatus`。诊断不包含会话 URL、凭据、SDP 或响应正文。`phase` 与 `elapsedMs` 只在有实际阶段和计时时出现，`cause` 只含错误名。诊断不会改变播放状态，也不会触发重连。 `close()` 后仍可能收到后台 DELETE 失败的诊断。诊断监听器抛错不会产生新的诊断，也不会中断其他监听器。

## 当前限制

- 只支持单个来源；切换来源须调用 `updateUrl()`，不会自动回退到备用流。
- 服务端用反向 offer 时，播放器需要可读的 `Location` 才能提交应答。
- 跨源部署未暴露 `Location` 时不发 DELETE，远端会话依赖服务端回收。
- 已知未验证：其他浏览器、更多 H.265 设备和系统组合、真实服务端的反向 offer 流程。详见[验收记录](docs/plans/2026-11-20-whepts-acceptance.md)。

## 开发与验证

```bash
pnpm install --frozen-lockfile
npm test
npm run lint
npm run format:check
pnpm exec tsc --noEmit
npm run build:debug
```

代码检查用 oxlint，格式化用 oxfmt，均使用工具默认配置，不维护项目级规则文件；`npm run lint:fix` 与 `npm run format` 分别自动修复。生产构建仍会剥离全部 `console` 与 `debugger`。

排查问题时运行 `npm run build:debug`，使用本地构建并在 DevTools 控制台开启 Verbose。调试构建保留源码映射，打印脱敏的状态变化、错误阶段、HTTP 状态和清理／采样诊断。生产构建移除控制台日志，应用仍可使用 `error` 和 `diagnostic` 事件。

`npm test` 构建生产入口并运行 Node 回归测试；它不替代真实浏览器互通测试。`npm pack` 会重新构建，不会自动发布。

- [打包验收](tests/package-smoke.sh)：运行 `bash tests/package-smoke.sh`，检查实际包的离线安装、ESM 入口及严格 TypeScript 类型。
- [Chrome 环回测试](tests/browser-redirect.py)：生产构建后运行 `python tests/browser-redirect.py`（需要 Python Playwright 和 Chrome，不需要媒体服务器）。
- 双服务器互通：[MediaMTX](tests/browser-mediamtx.py) 与 [ZLMediaKit](tests/browser-zlm.py) 使用独立浏览器脚本。启动条件、实测版本及远端清理限制见 [A1–A9 验收记录](docs/plans/2026-11-20-whepts-acceptance.md)。

## 许可证

MIT
