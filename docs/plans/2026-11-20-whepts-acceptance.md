# WhepTS 验收记录

验收标准见[架构方案](2026-11-20-whepts-architecture-design.md#L113-L125)。本文只记录证据与未验证项，模拟测试不算浏览器或服务端互通。

## 当前基线（`main` @ 1.2.1）

- `npm test`：91 项通过（含生产构建）。
- `npm run lint`、`node_modules/.bin/tsc --noEmit`：通过。
- `bash tests/package-smoke.sh`：实际 npm 包离线安装、ESM 入口、严格 NodeNext 与 Bundler 类型检查通过。
- `python tests/browser-redirect.py`：Chrome 环回三项通过（同源、跨源且暴露 `Location`、跨源但未暴露 `Location`）。
- `python tests/browser-visibility.py <whep-url>`：Chrome 视口内外挂载、解绑与恢复通过（MediaMTX 与 ZLMediaKit）。
- 双服务器实测：Chrome + MediaMTX 1.15.5 与 ZLMediaKit `52c38f8` 的双流播放、切流、本地关闭通过；远端 HTTP 清理结论见 A4。

上述命令都不启动媒体服务器；两台服务端的实测范围与限制见 A3、A4 与下方实测记录。

验收远端清理时分开记录三项：浏览器是否发出 DELETE、HTTP 响应状态、远端会话对象是否释放。MediaMTX 的 404 不算 HTTP 成功；ZLMediaKit 跨源读不到 `Location` 时不猜地址。

| 编号 | 现有证据 | 待补证据 |
| --- | --- | --- |
| A1 | 切源与冻结配置、迟到 POST/PATCH、终态不可复活、同地址更新取消待执行重连；双监听器验证已开始的派发继续、后续旧通知取消；切源后旧 OPTIONS 不再发起 POST、旧轨道不再发布事件 | — |
| A2 | SDP 响应正文超时时忽略迟到应答并仅清理一次、OPTIONS 超时、已知及迟到会话清理、PATCH 失败归一化；POST 结果未知时不重试或猜测会话地址；应答失败仅清理已登记会话一次；首次连通前的超时与 ICE 失败无论先后均只报错一次、不重试 | — |
| A3 | 实际 MID、索引 0、凭据作用域、批量候选及结束标记、全量 ICE 无 PATCH；候选 PATCH 串行及切源丢弃旧批次已通过回归；旧 PATCH 迟到返回 204 或 404 均不再发送旧候选，也不影响新会话。最新构建通过 Chrome 与 MediaMTX 1.15.5、ZLMediaKit 52c38f8 的双流播放、切流和本地关闭复验：MediaMTX 两次 PATCH 均返回 204，ZLMediaKit 的浏览器脚本已断言两路均只发送 OPTIONS 和 POST，分别返回 200 和 201，没有 PATCH 或 DELETE | PATCH 204 仅证明批次获响应，不证明服务端逐条处理顺序；仍需将同一会话的 Chrome 原生候选事件、PATCH 批次及服务端处理记录对照 |
| A4 | 混合 Link（逐条容错、`anchor` 跳过、TURN 缺凭据跳过）、HTTP 状态矩阵、最终响应 URL、认证范围、DELETE 诊断；缺失、格式错误、协议不受支持或内嵌凭据的 Location 均不影响有效 SDP，且不触发 PATCH 或 DELETE；Chrome 已验证两端的跨源播放、切流、本地关闭及响应头可见性差异；Chrome 到 ZLMediaKit 的跨源 POST 307 已验证；Chrome 环回夹具已验证同源及跨源 307 后相对 Location 的 DELETE：同源保留 Bearer，跨源 POST 与 DELETE 均不携带 Bearer；MediaMTX 末次 DELETE 404 已在 Chrome 验证结构化诊断；限时退役后 MediaMTX 1.15.5 两轮四次 DELETE 均为 200，日志均为 terminated；ZLMediaKit 52c38f8 经代理暴露 Location 后两次 DELETE 均为 200，上游复查均为 404，确认传输已从查找表移除。未暴露 Location 的负对照不发 DELETE | 双服务器的重定向与相对 Location 组合、ZLMediaKit 底层对象析构未验证 |
| A5 | 探测超时降级、视频 RTP 编码与时钟率、合成应答 MID/DTLS、7/8 声道 Multiopus 映射、音频 offer PT 不重复且避开保留范围；Chrome 原生探测报告支持 PCMA、Multiopus、L16 | 其他浏览器及扩展编解码器的实际解码 |
| A6 | 无 stream、音频先到、50% 可见性、手动暂停、宿主接管后旧播放监控停止、不再报告停滞，等待中的局部恢复也不会覆盖宿主流、迟到 play、自动播放拒绝、局部恢复耗尽后不再尝试播放、不关闭原 PeerConnection、不重发信令；无视频超时仅报告播放失败，最后视频轨道结束后可挂载替换轨道，旧 ended 不影响新流；模拟 RTP 字节增长但无视频帧时只报告播放停滞；Chrome 已在两台服务端的正常播放中观察到视频帧增长；Chrome + ZLMediaKit 52c38f8 实测手动暂停时视频元素进入 paused、传输仍保持 running；恢复后视频时钟超过暂停点 0.2 秒，随后切流并关闭解绑；仓库内 `python tests/browser-zlm.py http://127.0.0.1:28091` 已复跑通过（需先构建并启动上述版本服务及 `live/camera`、`live/backup` H.264 流） | 真实浏览器中人为制造无帧停滞并验证诊断尚未覆盖 |
| A7 | 采样互斥、缺失/多路/零增量报告、超时（逾期结果先于计时器回调返回时仍丢弃并仅报告一次）、前后台切换、稳态节奏、长时间未采样后重建基线；当前连接视频字节增长重置重连预算，已退役连接的迟到样本不重置；Chrome + ZLMediaKit 播放时被动记录播放器的原生 getStats 调用，连续两次入站视频字节为 287036、623810；同一夹具随后用单调时钟测得启动期两次调用相隔 4999.5 毫秒；启用 `WHEPTS_CHECK_STEADY_CADENCE=1` 后，观察到六次约 5 秒间隔，随后一次间隔 11 秒且字节继续增长，验证了该夹具的稳态切换 | 真实浏览器中的统计挂起、前后台切换后重建基线、断流恢复预算仍待实测 |
| A8 | 公开监听器与内部流程分离；监听器通过 `on`/`once`/`addListener` 统一包装，单个监听器抛错不中断其余监听器并进入公开的 `listener-error` 诊断（真实浏览器已验证）；DELETE 诊断覆盖 HTTP 错误、网络拒绝和独立 5 秒期限；候选 PATCH 失败或超时通过 `trickle-ice` 诊断上报并保留会话；诊断包含实例、原连接尝试和报告时的播放器状态；构造时统一解析 `iceMode` 与 `lazyLoad`，播放监控与调度器默认值各自集中；`play:stalled` 不拼接原始浏览器错误；`phase` 与 `elapsedMs` 在无意义时省略 | 其余取消路径（如编解码探测中断）的诊断归属 |
| A9 | 实际 npm tarball 离线安装，ESM 导入及 TypeScript 5.9.3 严格 NodeNext/Bundler 检查；生产构建前后已跟踪及未跟踪源码的路径与内容快照一致；实际包包含 JS 与声明入口，不包含测试夹具；旧构造方式、事件监听器、播放控制与切源方法，以及新增诊断字段，均已通过实际包的严格类型消费检查；实际包的 ESM 运行时还验证了错误命名导出、全部六个既有 `ErrorTypes` 值、数值型 `httpStatus`、旧构造省略可选字段及 `setup-timeout` 的字段语义；PATCH 串行化及采样默认值归属调整后的构建已复跑实际包验收；可用 `bash tests/package-smoke.sh` 复现（需已安装构建依赖且 npm 缓存含运行时依赖） | 诊断派发合并后已复验；后续生产代码变更仍须重跑 |

## 复现命令

- A7 稳态切换：沿用 ZLMediaKit 双流环境，两路推流至少维持 85 秒，运行 `WHEPTS_CHECK_STEADY_CADENCE=1 python tests/browser-zlm.py http://127.0.0.1:28091`。脚本在首流进入稳态后再切源，只观测原生统计。
- A4 清理：MediaMTX 加 `WHEPTS_REQUIRE_DELETE_SUCCESS=1`；ZLMediaKit 加 `--expose-location`，并另跑一次不加该参数的负对照。
- 自动化回归：[生命周期回归](../../tests/lifecycle.test.mjs)，运行 `npm test`。

## 双服务器实测记录

**MediaMTX 1.15.5。** 容器内 FFmpeg 7.1 发布合成 H.264；宿主 FFmpeg 因缺少 libjxl 未能运行。Chrome 158.0.8127.36 无头模式下，跨源 fetch 首次被 loopback 地址空间权限拦截，改用实际 HTTP 页面后正常。`trickle` 双流：OPTIONS 204、POST 201、PATCH 204，切流后视频宽度 160 且播放时间前进。

**MediaMTX 清理竞态。** 播放中手动向同一 `Location` 发 DELETE 返回 200 并终止会话；随后播放器再发 DELETE 返回 404，说明服务端已随 PeerConnection 关闭回收。只调整播放器时序（先发 DELETE，再同步关闭旧连接，不等待响应）后，两轮复验共 4 次 DELETE 均返回 200，日志均为 `closed: terminated`。`python tests/browser-mediamtx.py http://127.0.0.1:18889` 复现，需先构建并启动该版本服务及 `live`、`backup` H.264 流。

**ZLMediaKit `52c38f8`**（amd64 镜像 `sha256:9652056b…756af47`）。`complete` 模式双流：OPTIONS 200、POST 201，未观察到 PATCH；切流后宽度 160，播放时钟前进。预检允许 POST 与 DELETE。

**ZLMediaKit 清理。** 原生响应带 `Location`，但未返回 `Access-Control-Expose-Headers`，页面读不到地址，播放器不发 DELETE；`python tests/browser-zlm.py http://127.0.0.1:28091` 断言这一负对照。测试代理暴露 `Location` 后，切流与关闭的两次 DELETE 均返回 200，直接向上游复查均返回 404，确认传输已从查找表移除。服务端对两个会话均记录 DTLS close notify 后的 transport shutdown。

**排查记录。** 早期宿主网络对照的 POST 404 来自占用旧端口 18091 的其他服务（`Server: llama.cpp`），不属于 ZLMediaKit 证据；改用空闲端口 28091 后复验通过。容器端口映射下的 ICE 超时未再解释，以宿主网络结果为准。

**重定向。** 真实 Chrome 从同源 307 到 ZLMediaKit 收到 201 并播放，但最终 `Location` 未暴露，不覆盖重定向后的相对地址清理。[Chrome 环回夹具](../../tests/browser-redirect.py)补验三种场景：可读 `Location` 时只发一次 DELETE 并返回 204；不可读时不发 DELETE；均不发 PATCH，且失败只报告一次 `connection` 阶段错误。运行前需 `npm run build`，可用 `CHROME_BIN` 指定浏览器。

**2026-11-23 复验（`ba4c308`）。** 两台服务端均按上述固定版本本机自启，使用同一生产构建：

- MediaMTX：`live` → `backup` 切流正常，两路 PATCH 204；严格模式下两次 DELETE 均 200，服务端两次 `closed: terminated`。
- ZLMediaKit：经测试代理暴露 `Location` 后两次 DELETE 均 200，上游复查找不到传输；不暴露 `Location` 的负对照两路 POST 201、无 DELETE。播放 164 帧，暂停恢复与切流通过。

两次运行使用相同合成 H.264 流与 Chrome 版本；结论仍限于本机部署。

后续修复（元素重新接管、监听器异常隔离、候选 PATCH 超时）之后，`main` 上再次复验：MediaMTX 切流、严格 DELETE 与 Chrome 视口夹具均通过；新增回归覆盖监听器隔离（含 `off`/`context`/重复注册）、切源重新挂载、候选批次超时与归属。
