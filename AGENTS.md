# AGENTS.md

WhepTS 是浏览器中的单源 WebRTC WHEP 播放器库。它负责连接、媒体挂载与清理；调用方负责选择地址、凭据和备用流。本文件是仓库的工作规范，面向修改本仓库的开发者与代理。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 生产构建，压缩并剥离全部 `console` 与 `debugger` |
| `npm run build:debug` | 调试构建，保留源码映射与日志 |
| `npm test` | 先构建生产包，再运行 `tests/*.test.mjs` |
| `npm run lint` | oxlint 检查 `src` 与 `tests` |
| `npm run lint:fix` | oxlint 自动修复 |
| `npm run format` | oxfmt 格式化 |
| `npm run format:check` | 校验格式，不写文件 |
| `node_modules/.bin/tsc --noEmit` | 类型检查 |

浏览器与服务端互通不能由上述命令替代：浏览器夹具见 `tests/browser-*.py`，打包冒烟见 `tests/package-smoke.sh`，证据与未验证项见[验收记录](docs/plans/2026-11-20-whepts-acceptance.md)。

## 目录

```
src/index.ts            对外入口，导出默认 WebRTCWhep 与公开类型
src/whep.ts             播放器主体：状态机、连接尝试、清理、事件派发
src/types.ts            公开类型：Conf、State、WhepEvents、WhepDiagnostic
src/errors.ts           ErrorTypes 与 WebRTCError
src/core/connection.ts  RTCPeerConnection 生命周期、ICE 候选、反向 offer 应答
src/core/http.ts        WHEP 的 OPTIONS/POST/PATCH/DELETE 与认证
src/core/track.ts       轨道归并、媒体元素挂载、可见性驱动的暂停与恢复
src/core/codec.ts       启动时探测未通告编解码器
src/utils/sdp.ts        SDP 解析、负载类型预留、trickle 片段生成
src/utils/webrtc.ts     编解码器支持探测、Link 头解析
src/monitors/scheduler.ts    每实例独立的监控调度器
src/monitors/play-monitor.ts 播放停滞检测与元素恢复
src/monitors/flow-monitor.ts 入站字节采样与断流检测
```

## 代码约定

**导入**：跨目录用 `~/` 别名（`import { ErrorTypes } from "~/errors";`），同目录用相对路径。类型导入必须写 `import type`。外部依赖在前，内部导入在后。

**格式与检查**：oxlint 与 oxfmt 均使用工具默认配置，仓库不维护项目级规则文件。提交前运行 `npm run format` 与 `npm run lint:fix`，不要手工调整格式。

**类型**：`tsconfig.json` 开启 `strict`、`strictNullChecks`、`noUnusedLocals`。对象形状用 `interface`，联合与别名用 `type`；不使用 `any`。

**命名**：类与接口 PascalCase，函数与方法 camelCase，常量 UPPER_SNAKE_CASE，私有成员加 `private`。

**注释与语言**：实现注释用中文，公开 API 与类构造函数用英文 JSDoc。**所有事件负载与错误消息必须用英文**，供调用方按码值匹配和检索；中文只出现在注释中。

```typescript
// ✅ 事件负载用英文，注释用中文
// 断流停滞
notify("playback:flow-stalled", { reason: "Stream interrupted: video flow stalled" });

// ❌ 事件负载用中文
notify("playback:flow-stalled", { reason: "数据流中断" });
```

## 状态与失败

状态是联合字面量：`"getting_codecs" | "running" | "restarting" | "closed" | "failed"`。`closed` 是终态，除清理外不再接受任何操作；操作前先判断状态。派生值用 getter，例如 `get paused()`。

失败路径只有两个出口：`failSetup(phase, error, reason?)` 负责清理、转 `failed` 并派发一次 `error`；`notifyError(error)` 只派发既有错误。两者都保证状态与诊断一致，不要另起错误派发路径。

`ErrorTypes` 的值是 `"SignalError"`、`"StateError"`、`"RequestError"`、`"OtherError"`。HTTP 失败统一为 `REQUEST_ERROR`，具体状态码放在 `httpStatus`；不要把状态码映射成具体原因。

首次连接失败由调用方决定是否重试。POST 返回 `409` 且有可读、有效的 `Retry-After` 时，通过 `WebRTCError.retryAt` 提供 Unix 毫秒时间戳；期限内拒绝同一实例对该端点的重试，不排队。已连通传输断开后按 `2000/4000/8000` 毫秒重试同一来源，预算耗尽转 `failed`。不会自动切备用流。

## 诊断

`diagnostic` 事件携带 `WhepDiagnostic`，覆盖 `delete-session`、`sample-flow`、`trickle-ice`、`listener-error` 四类操作。字段只含 `playerId`、`attemptId`、`state`、`operation`、`phase`、`elapsedMs`、`reason`、`httpStatus`、`cause`；`cause` 仅保留脱敏错误名，`phase` 与 `elapsedMs` 在没有实际阶段或计时时不出现。诊断不改变播放状态，也不触发重连。

新增诊断必须沿用同一契约：不放入会话 URL、凭据、SDP 或响应正文。

## 媒体与元素

媒体元素是调用方借出的，同一元素只交给一个活跃播放器。

- 播放器以自家 `MediaStream` 为唯一真值：宿主带外改写 `srcObject` 时不回写；调用方通过 `pause()`/`resume()`/`updateUrl()` 主动驱动时才重新接管。
- 赋值 `srcObject` 会按 HTML 规范重置加载状态，挂载新流后必须显式调用一次 `play()`，不能靠 `paused` 判断跳过。
- 切源时不先把元素置 `null` 再赋值，避免多跑一次加载。
- `lazyLoad` 默认开启，`IntersectionObserver` 阈值 `0.5`；隐藏时保持传输但解绑元素。
- 没有视频轨道时派发 `playback:failed`，码值 `video-unavailable`，不进入 `failed` 状态。
- 元素崩溃恢复最多 3 次，间隔 1 秒；耗尽派发 `element-recovery-exhausted`。

## 监控

每个播放器实例拥有独立的 `MonitorScheduler`，不共享单例。任务按类型名注册并去重；多实例时按自适应节流降频。

`PlayMonitor` 每 5 秒采样播放时钟判断停滞，挂载后 500 毫秒做启动校验，首个停滞样本只建立基线。`FlowMonitor` 每 5 秒采样 `RTCPeerConnection` 入站视频字节数，30 秒后降到 10 秒；样本不可比较时重建基线。两者都只通知，从不触发重连。

## 协议

`iceMode` 默认 `trickle`，`complete` 时等待收集完成后发送完整 offer 且不发送候选 PATCH。

候选按批发送，每批 5 秒独立期限；失败或超时只丢弃该批并通过 `trickle-ice` 上报，会话继续。候选 PATCH 的 `204` 表示候选已聚合；收到 `200` 时仅接收新 `ETag`，不执行原地 ICE 重启。PeerConnection 使用 `max-bundle`。

服务端用 `406` + `application/sdp` 发反向 offer 时，生成 answer 并以 `PATCH application/sdp` 提交，期望 `204`；缺少可读会话地址或反向 offer 过期时报错，不猜测目标。

`Link` 头按 RFC 8288 逐条解析，跳过不可用地址、带 `anchor` 无法重设锚点的链接、缺 `username`/`credential` 的 TURN 地址；只有响应声明了 ICE 服务器且一条可用都没有时才报告失败。

SDP 使用 unified-plan 语义；负载类型在 30–127 之间预留，跳过 64–95。

## 日志

生产构建剥离全部 `console`，不要把日志当作面向用户的诊断手段。

- 播放器自身故障与诊断出口用 `console.warn`。
- 调用方原因或预期内降级用 `console.debug`：编解码探测失败、监听器抛错、调度任务失败。
- 永远不记录凭据、会话 URL、SDP、ICE 凭据或候选。
- 日志统一加 `[WhepTS]` 前缀并附带 `playerId`。

## 公开 API

`src/index.ts` 默认导出 `WebRTCWhep`，并导出 `Conf`、`State`、`WhepEvents`、`WhepDiagnostic`、`ErrorTypes`、`WebRTCError`。

`Conf` 字段：`url`、`container`、`user`、`pass`、`token`、`iceServers`、`iceMode`、`lazyLoad`。新增配置项须在 `src/types.ts` 写 JSDoc，并处理状态校验、资源清理、状态迁移与事件通知。

公开方法与访问器：构造 `constructor(conf)`、`get state`、`get paused`、`pause()`、`resume()`、`updateUrl(url)`、`close()`。事件监听沿用 `EventEmitter`：`on`、`once`、`addListener` 注册的监听器统一包装，单个监听器抛错不中断其余监听器，也不影响播放，非诊断监听器的异常通过 `listener-error` 上报，诊断监听器的异常只记调试日志；`off` 与 `removeListener` 按原引用移除。

事件：`webrtc:codecs-detected`、`player:state-changed`、`webrtc:ice-candidate`、`webrtc:track-received`、`playback:started`、`playback:failed`（`autoplay-blocked`、`video-unavailable`、`element-recovery-exhausted`、`playback-error`）、`playback:stalled`、`playback:flow-stalled`、`error`、`diagnostic`、`player:closed`、`player:retry-scheduled`。

## 提交前

1. `npm run format` 与 `npm run lint` 通过。
2. `npm test` 与 `node_modules/.bin/tsc --noEmit` 通过，且确认 `# fail 0`。
3. 涉及协议、清理或媒体的行为改动，按需重跑对应浏览器夹具；只在 `npm test` 通过时不要声称互通已验证。

## 未覆盖范围

其他浏览器、更多 H.265 设备和系统组合、真实服务端的反向 offer 流程、ZLMediaKit 跨源暴露 `Location` 的真实部署清理均未验证。细节见[验收记录](docs/plans/2026-11-20-whepts-acceptance.md)。
