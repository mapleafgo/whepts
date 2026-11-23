# WhepTS 验收记录

验收标准见[架构方案](2026-11-20-whepts-architecture-design.md#L113-L125)。下表记录已有证据与下一步，不把模拟测试视为浏览器或服务端互通。

当前回归基线：`npm test`（含生产构建，54 项通过）、`npm run lint`、`node_modules/.bin/tsc --noEmit`，以及产出 `dist/` 后运行 `python tests/browser-redirect.py`（Chrome 环回三项通过：同源、跨源且暴露 Location、跨源但未暴露 Location）。这些命令不启动 MediaMTX 或 ZLMediaKit；两台服务端的实测范围及远端清理限制另见 A4 和下方记录。

本次工作区最终复跑：54 项自动化测试、生产构建、ESLint、TypeScript、实际 npm 包离线消费及 3 项 Chrome 环回均通过；未重跑双服务器。下表未验证项保持开放，不将本地通过视为全部验收完成。 随后在当前 `main` 重新构建并复验 ZLMediaKit 52c38f8：Chrome 初始流观察到 50 帧，暂停恢复、切流和本地关闭通过；两路 Location 均未向页面暴露，无 PATCH 或 DELETE。同一构建随后复验 MediaMTX 1.15.5：Chrome 双流播放、切流及关闭解绑通过，两次 PATCH 返回 204。两次 DELETE 返回 404，末次清理失败诊断通过，服务端日志确认两个会话随 PeerConnection 关闭而回收。

继续验收时，优先分开记录三项结果：浏览器是否发出 DELETE、服务端的 HTTP 响应、远端会话对象是否释放。MediaMTX 的 404 不算 HTTP 成功；ZLMediaKit 在跨源 Location 不可读时不应猜测地址。要验收重定向后的远端清理，需在实际服务端部署中同时观测最终响应、页面可读的相对 Location 和服务端回收证据。

| 编号 | 现有证据 | 待补证据 |
| --- | --- | --- |
| A1 | 切源与冻结配置、迟到 POST/PATCH、终态不可复活、同地址更新取消待执行重连；双监听器验证已开始的派发继续、后续旧通知取消；切源后旧 OPTIONS 不再发起 POST、旧轨道不再发布事件 | — |
| A2 | SDP 响应正文超时时忽略迟到应答并仅清理一次、OPTIONS 超时、已知及迟到会话清理、PATCH 失败归一化；POST 结果未知时不重试或猜测会话地址；应答失败仅清理已登记会话一次；首次连通前的超时与 ICE 失败无论先后均只报错一次、不重试 | — |
| A3 | 实际 MID、索引 0、凭据作用域、批量候选及结束标记、全量 ICE 无 PATCH；候选 PATCH 串行及切源丢弃旧批次已通过回归；旧 PATCH 迟到返回 204 或 404 均不再发送旧候选，也不影响新会话。最新构建通过 Chrome 与 MediaMTX 1.15.5、ZLMediaKit 52c38f8 的双流播放、切流和本地关闭复验：MediaMTX 两次 PATCH 均返回 204，ZLMediaKit 的浏览器脚本已断言两路均只发送 OPTIONS 和 POST，分别返回 200 和 201，没有 PATCH 或 DELETE | PATCH 204 仅证明批次获响应，不证明服务端逐条处理顺序；仍需将同一会话的 Chrome 原生候选事件、PATCH 批次及服务端处理记录对照 |
| A4 | 混合 Link（逐条容错、`anchor` 跳过、TURN 缺凭据跳过）、HTTP 状态矩阵、最终响应 URL、认证范围、DELETE 诊断；缺失、格式错误、协议不受支持或内嵌凭据的 Location 均不影响有效 SDP，且不触发 PATCH 或 DELETE；Chrome 已验证两端的跨源播放、切流、本地关闭及响应头可见性差异；Chrome 到 ZLMediaKit 的跨源 POST 307 已验证；Chrome 环回夹具已验证同源及跨源 307 后相对 Location 的 DELETE：同源保留 Bearer，跨源 POST 与 DELETE 均不携带 Bearer；MediaMTX 末次 DELETE 404 已在 Chrome 验证结构化诊断；限时退役后 MediaMTX 1.15.5 两轮四次 DELETE 均为 200，日志均为 terminated；ZLMediaKit 52c38f8 经代理暴露 Location 后两次 DELETE 均为 200，上游复查均为 404，确认传输已从查找表移除。未暴露 Location 的负对照不发 DELETE | 双服务器的重定向与相对 Location 组合、ZLMediaKit 底层对象析构未验证 |
| A5 | 探测超时降级、视频 RTP 编码与时钟率、合成应答 MID/DTLS、7/8 声道 Multiopus 映射、音频 offer PT 不重复且避开保留范围；Chrome 原生探测报告支持 PCMA、Multiopus、L16 | 其他浏览器及扩展编解码器的实际解码 |
| A6 | 无 stream、音频先到、50% 可见性、手动暂停、宿主接管后旧播放监控停止、不再报告停滞，等待中的局部恢复也不会覆盖宿主流、迟到 play、自动播放拒绝、局部恢复耗尽后不再尝试播放、不关闭原 PeerConnection、不重发信令；无视频超时仅报告播放失败，最后视频轨道结束后可挂载替换轨道，旧 ended 不影响新流；模拟 RTP 字节增长但无视频帧时只报告播放停滞；Chrome 已在两台服务端的正常播放中观察到视频帧增长；Chrome + ZLMediaKit 52c38f8 实测手动暂停时视频元素进入 paused、传输仍保持 running；恢复后视频时钟超过暂停点 0.2 秒，随后切流并关闭解绑；仓库内 `python tests/browser-zlm.py http://127.0.0.1:28091` 已复跑通过（需先构建并启动上述版本服务及 `live/camera`、`live/backup` H.264 流） | 真实浏览器中人为制造无帧停滞并验证诊断尚未覆盖 |
| A7 | 采样互斥、缺失/多路/零增量报告、超时（逾期结果先于计时器回调返回时仍丢弃并仅报告一次）、前后台切换、稳态节奏、长时间未采样后重建基线；当前连接视频字节增长重置重连预算，已退役连接的迟到样本不重置；Chrome + ZLMediaKit 播放时被动记录播放器的原生 getStats 调用，连续两次入站视频字节为 287036、623810；同一夹具随后用单调时钟测得启动期两次调用相隔 4999.5 毫秒；启用 `WHEPTS_CHECK_STEADY_CADENCE=1` 后，观察到六次约 5 秒间隔，随后一次间隔 11 秒且字节继续增长，验证了该夹具的稳态切换 | 真实浏览器中的统计挂起、前后台切换后重建基线、断流恢复预算仍待实测 |
| A8 | 公开监听器与内部流程分离；生产构建的 DELETE 诊断覆盖 HTTP 错误、网络拒绝和独立 5 秒期限，只报告一次且不影响关闭；DELETE 失败和采样超时共用诊断派发；诊断包含实例、原连接尝试和报告时的播放器状态；切源后迟到的旧会话清理失败仍关联旧尝试，不影响新会话；构造时统一解析 `iceMode` 和 `lazyLoad`，播放监控时限及调度器默认值分别集中定义；调度器降频阈值按实际间隔超出计划间隔的时间计算；流量监控器统一解析采样默认值（初始 5 秒，30 秒稳定期后 10 秒）；`play:stalled` 不拼接原始浏览器错误，已通过脱敏回归；采样超时通过 `sample-flow` 诊断报告，不重叠采样也不重连；调用方诊断回调抛错不影响切源后的采样，已通过专项回归；实际包已通过严格 NodeNext/Bundler 类型检查；关闭时取消在途采样，旧请求即使逾期并拒绝也不新增故障诊断（专项回归已通过）。切源后旧 PATCH 返回 204 或 404 均不触发公开错误或诊断（专项回归已通过） | 生产结构化回调目前仅覆盖 DELETE 失败和流量采样超时；公开监听器抛错仅有调试警告，生产包不可见。其余取消路径及默认值归属仍待核验。 |
| A9 | 实际 npm tarball 离线安装，ESM 导入及 TypeScript 5.9.3 严格 NodeNext/Bundler 检查；生产构建前后已跟踪及未跟踪源码的路径与内容快照一致；实际包包含 JS 与声明入口，不包含测试夹具；旧构造方式、事件监听器、播放控制与切源方法，以及新增诊断字段，均已通过实际包的严格类型消费检查；实际包的 ESM 运行时还验证了错误命名导出、全部六个既有 `ErrorTypes` 值、数值型 `httpStatus`、旧构造省略可选字段及 `setup-timeout` 的字段语义；PATCH 串行化及采样默认值归属调整后的构建已复跑实际包验收；可用 `bash tests/package-smoke.sh` 复现（需已安装构建依赖且 npm 缓存含运行时依赖） | 诊断派发合并后已复验；后续生产代码变更仍须重跑 |

复现 A7 稳态切换：沿用下方 ZLMediaKit 双流环境，两路推流至少维持 85 秒，运行 `WHEPTS_CHECK_STEADY_CADENCE=1 python tests/browser-zlm.py http://127.0.0.1:28091`。脚本在首流等待切换到稳态后再切源；只观测原生统计，不替换采样值。默认不启用这段长时等待。

本轮 A4 清理验收：播放器同步更新状态、解绑并隔离旧连接，新连接不等旧 DELETE；旧 PeerConnection 等 DELETE 结算或 5 秒期限后关闭。MediaMTX 使用 `WHEPTS_REQUIRE_DELETE_SUCCESS=1`；ZLMediaKit 使用 `--expose-location`（不使用 `--hold-peer-close`），并复跑未暴露对照。A3 候选顺序及 A7 异常采样另行验收。

自动化用例集中在[生命周期回归](../../tests/lifecycle.test.mjs)，运行 `npm test`。MediaMTX 1.15.5 已在本机容器启动；使用 curl 对 WHEP 路径发送带 Origin 的 POST 预检，返回 204，允许 OPTIONS、GET、POST、PATCH、DELETE 及 Authorization、Content-Type、If-Match。另使用容器化 FFmpeg 7.1 发布 3 秒合成 H.264，服务端日志确认 RTSP `live` 路径收到一个 H.264 轨道；宿主 FFmpeg 因缺少 libjxl.so.0.12 未运行。以上检查不验证浏览器 CORS 执行、Location/ETag 可见性、媒体播放、切流或关闭。后续浏览器复验及尚未覆盖的检查见下文。

Chrome 158.0.8127.36（无头）加载生产产物后报告 PCMA、Multiopus 与 L16 探测通过；随后跨源 WHEP fetch 被 Chrome 的 loopback 地址空间权限拦截，未观察到 WHEP 应答或视频帧。未禁用浏览器安全策略，不能据此判定服务端 CORS 头有误。

使用实际 HTTP 页面（不拦截导航）重试后，Chrome 跨源访问 MediaMTX 1.15.5 成功：OPTIONS 204、POST 201、PATCH 204，视频帧计数达到 3。关闭时 DELETE 返回 404，服务端日志同时记录 peer connection closed；尚未确认两者的因果关系，关闭互通未通过。切流、重定向、ETag 精确可见性与 ZLMediaKit 仍未验证。

对照测试确认 Chrome 页面脚本可读取 POST 响应的 Location 和 ETag；播放器仍在播放时，手动向同一 Location 发送 DELETE 返回 200，服务端记录会话终止，随后播放器再次 DELETE 返回 404。这支持关闭顺序竞态的判断；未将手动 DELETE 算作播放器关闭通过。

无手动 DELETE 的复验中，连续两次调用 `close()` 后同步确认状态为 `closed`、视频元素已解绑，并观察到播放器向登记的 Location 发出 DELETE。MediaMTX 日志确认会话因 PeerConnection 关闭而回收，DELETE 仍返回 404。本地关闭和服务端回收已观测到；不将 404 记为 DELETE 成功，也不为等待远端响应而延迟本地关闭。

后续对照只调整播放器时序：先调用 Fetch 发起 DELETE，再同步关闭 PeerConnection，不等待 HTTP 响应。Chrome + MediaMTX 1.15.5 双流复验中，切流与最终关闭的 DELETE 均返回 200，服务端均记录 `closed: terminated`。这是该环境的两次观测，不保证跨网络时序。

Chrome + MediaMTX 1.15.5 双流复验：通过 `updateUrl()` 从 `live` 切到 `backup`，确认装载不同的 MediaStream、新视频宽度为 160 且播放时间前进。两次建连均观察到 OPTIONS 204、POST 201、PATCH 204；旧流和新流均在 PeerConnection 关闭后被服务端回收，对应 DELETE 均返回 404。 仓库内 `python tests/browser-mediamtx.py http://127.0.0.1:18889` 已复跑通过，脚本分别断言两路 POST 201 后均有 PATCH 204；DELETE 状态不纳入 HTTP 清理成功断言；关闭时收到非 2xx 则验证 `delete-session` 诊断归属末次尝试且状态保持 `closed`，实测为 `http-error` / 404（须先构建并启动 MediaMTX 1.15.5 及 `live`、`backup` H.264 流）。

ZLMediaKit amd64 镜像固定为 `sha256:9652056bddf6bce982442d74a8dbb0530bbd4c112132df7dabfbdfd8f756af47`（服务端 Git `52c38f8`）。本机 WHEP POST 预检返回 200，回显测试 Origin，允许 POST 和 DELETE，未声明 PATCH。此处只验证 HTTP 预检；浏览器全量 ICE、播放、切流和关闭尚未验证。

首次 Chrome 实测：RTMP 合成流已发布，`iceMode: complete` 下观察到 OPTIONS 200、POST 201，未观察到 PATCH，页面未能读取 Location 或 ETag。此后连接阶段超时，未观察到视频出帧。测试使用容器端口映射，尚需核对 SDP 通告的 ICE 地址与宿主可达性；不能据此判定播放器或服务端不兼容。

宿主网络对照未进入浏览器阶段：使用镜像默认配置启动时，非特权容器绑定 RTSP 554 被拒绝并退出。后续可使用测试专用高位监听端口，无需提高容器权限；此结果不解释端口映射场景的 ICE 超时。

改用非特权高位端口后，宿主网络服务成功启动，Chrome 收到 OPTIONS 200，但 WHEP POST 返回 404，未进入 ICE。下一步需结合推流日志确认该配置下 `live/camera` 是否已注册，并区分流不存在和 WHEP 路由未命中；目前不能用此对照解释端口映射场景的连接超时。

同配置复验已将推流成功与 WHEP 404 关联到同一次运行：服务端在请求前注册了 `__defaultVhost__/live/camera` 的 RTSP、RTMP 和 fMP4 媒体，确认收到 H.264，Chrome 的 WHEP POST 仍返回 404。因此不能简单归因为未推流；实际 WHEP 路由和虚拟主机匹配仍需验证。

从固定镜像提取完整默认配置，仅替换 HTTP/RTSP/RTMP/RTC 监听端口及 RTC 通告地址后，真实 Chrome 在宿主网络仍收到 OPTIONS 200、POST 404。该结果表明仅恢复默认配置不足以解决 404，仍未验证全量 ICE 播放、切流及关闭。

进一步检查本地测试响应：同一次运行中已确认 `live/camera` 注册，WHEP POST 的 404 响应正文为 `File Not Found`，播放器仍只报告脱敏的信令失败及 HTTP 404。尚未确认 404 来自哪一层路由；下一轮应比对响应 `Server` 头与容器日志，确认浏览器请求确实到达预期监听器。

已定位宿主网络对照中的 404：旧 HTTP 端口 18091 已由其他服务占用，响应 `Server` 为 `llama.cpp`，不是 ZLMediaKit；这些 404 不属于 ZLMediaKit 兼容性证据。改用空闲端口 28091，预检确认 `Server` 为固定版本 ZLMediaKit 后，Chrome 全量 ICE 实测收到 OPTIONS 200、POST 201，观察到 48 帧视频，未观察到 PATCH；页面仍不可读取 Location/ETag。调用 `close()` 后已确认本地状态为 `closed` 且视频解绑；远端回收未验证。随后双流复验从 `camera` 切至 `backup`：初始流观察到 46 帧；新 MediaStream 的视频宽度为 160，播放时钟继续前进。两路均收到 OPTIONS 200、POST 201，未观察到 PATCH，脚本通过本地关闭和解绑断言。再次双流复验通过，并对比浏览器网络记录与页面 Fetch：两次 POST 201 的原始响应均包含 Location，但没有 ETag，也未发送 Access-Control-Expose-Headers；页面 Fetch 因此无法读取 Location，播放器没有发出 DELETE。仓库内 [ZLMediaKit 浏览器脚本](../../tests/browser-zlm.py) 已实测断言两路原始响应均有 Location、页面 Fetch 均不可见；仍未验证 HTTP DELETE 或远端会话对象最终释放。

再跑双流并在停止容器前检查服务器日志：切流和本地关闭后，ZLMediaKit 对两个不同的 WebRTC 会话均记录了收到 DTLS close notify 后的 transport shutdown。此证据覆盖服务端传输关闭，不等同于 HTTP DELETE 成功，也未独立核对会话对象的最终释放。

真实 Chrome 重定向复验：同源入口 OPTIONS 204、POST 307，浏览器保留 POST 方法并跟随到跨源 ZLMediaKit（Git `52c38f8`），收到 201，观察到 45 帧视频并通过本地关闭断言。最终响应的 Location 仍未对页面暴露，因此不覆盖重定向后的相对会话地址清理。

Chrome 环回 HTTP 夹具补验：POST `/entry` 返回 307，最终 `/final/whep` 返回 201、相对 `Location: session` 及无效 SDP；播放器建连失败后 DELETE `/final/session` 返回 204。三种场景均只报告一次 `connection` 阶段错误，浏览器请求事件与服务端记录均确认：可读 Location 时仅发一次 DELETE，不可读时不发 DELETE，且不发送 PATCH；重复关闭后保持 `closed`。跨源响应未暴露 Location 时，Chrome 网络记录仍可见该头，但播放器不猜测地址、不发送 DELETE。该夹具验证最终响应 URL 的解析、CORS 可见性和失败清理，不是双服务器的媒体流实测。可在安装 Python Playwright 和 Chrome 后，运行 `npm run build` 与 `python tests/browser-redirect.py` 复现；可用 `CHROME_BIN` 指定浏览器路径。
