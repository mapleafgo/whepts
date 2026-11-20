# WhepTS：跨协议播放器架构调研

2026-11-20；WhepTS 审查基线 a22afd7。本文对比固定版本源码与上游测试，不主张引入其他协议或依赖；未运行上游测试。WHEP 互通另见[协议调研](2026-11-20-whepts-community-research.md)。

| 样本 | 源码观察 | 对 WhepTS 的启示与限制 |
| --- | --- | --- |
| hls.js v1.6.13 | [loadSource / detach / destroy](https://github.com/video-dev/hls.js/blob/abb6945bd29eadc04c25b2522528ca6aa619992f/src/hls.ts#L432-L525) 区分停止加载、解绑元素和实例销毁；[流控制器](https://github.com/video-dev/hls.js/blob/abb6945bd29eadc04c25b2522528ca6aa619992f/src/controller/base-stream-controller.ts#L497-L531) 检查异步上下文；[停滞处理](https://github.com/video-dev/hls.js/blob/abb6945bd29eadc04c25b2522528ca6aa619992f/src/controller/gap-controller.ts#L628-L678) 先做本地恢复。 | 借鉴分层恢复，不照搬 MSE 缓冲区跳转，也不照搬[公私共用事件总线](https://github.com/video-dev/hls.js/blob/abb6945bd29eadc04c25b2522528ca6aa619992f/src/hls.ts#L348-L418)：在 WhepTS 中，公开监听器可被移除或同步重入。 |
| Shaka Player v4.16.0 | [load](https://github.com/shaka-project/shaka-player/blob/7bd1d5daf3b59e6509cf9af3da2014fdd8ad354c/lib/player.js#L1701-L1774) 用操作 ID 和阶段互斥；[中断处理](https://github.com/shaka-project/shaka-player/blob/7bd1d5daf3b59e6509cf9af3da2014fdd8ad354c/lib/player.js#L1985-L1999) 不卸载后来者。 | 借鉴最后一次加载生效和旧操作无权清理新资源；不照搬预加载图，也不把整个建连 Promise 排进全局队列。 |
| Video.js v8.23.4 | [换源](https://github.com/videojs/video.js/blob/8e4ec97eb9a38dc1e5571b2b4a996df387139f1f/src/js/player.js#L3554-L3714) 可替换 Tech 或其 source handler；[handler 替换](https://github.com/videojs/video.js/blob/8e4ec97eb9a38dc1e5571b2b4a996df387139f1f/src/js/tech/tech.js#L1379-L1428) 清理前一个 handler，不等于销毁 Player。 | 保持播放器与调用方提供的元素稳定；不引入 Tech 注册表，不删除调用方的 DOM，也不把旧 fallback 监听器清理当成完整异步隔离。 |
| LiveKit JS v2.15.5 | [Room 建连/取消](https://github.com/livekit/client-sdk-js/blob/7e2dc68a5650dac629c157ca1e5ec68117b218dc/src/room/Room.ts#L879-L950)、[引擎重试](https://github.com/livekit/client-sdk-js/blob/7e2dc68a5650dac629c157ca1e5ec68117b218dc/src/room/RTCEngine.ts#L850-L946) 与 [轨道挂载/播放](https://github.com/livekit/client-sdk-js/blob/7e2dc68a5650dac629c157ca1e5ec68117b218dc/src/room/track/Track.ts#L129-L243) 是不同环节；自动播放拒绝与中断区别对待。 | 区分传输健康、轨道挂载、播放意图和实际播放；不引入房间、参与者或订阅图。 |

## 对当前架构的判断

- [播放器](../../src/whep.ts#L58-L70) 用公开事件驱动内部控制；[重试与清理](../../src/whep.ts#L79-L175) 又有多个入口。仅替换 EventEmitter 或状态容器不会解决所有权和同步重入。
- [建连与应答](../../src/whep.ts#L177-L206) 用共享字段承接不同连接的异步结果；停止旧工作与禁止旧结果提交是两件事，分别需要取消与尝试身份检查。不能让新会话等待旧请求或远端删除完成。
- [轨道模块](../../src/core/track.ts#L39-L104) 混合媒体挂载、可见性和用户意图。播放器借用元素；只解绑自己挂载且尚未被替换的流。暂停不等于关连接，自动播放失败不等于断流。

## 结构候选（未定案）

1. 保留公开事件总线作为内部控制：迁移短，但保护内部监听器和排查同步重入的成本仍在。
2. **单一生命周期协调器 + 独立连接尝试 + 媒体控制（推荐）**：协调器拥有当前尝试、状态提交和唯一重连计时器；尝试封装 HTTP、PeerConnection、会话清理；媒体模块拥有挂载与本地恢复。监控只报告证据；公开事件只通知。仅串行处理共享资源的提交点，不串行等待所有 I/O。
3. 全量异步命令队列或多协议插件内核：前者容易让最新命令被慢任务阻塞，仍需取消；后者在没有第二种协议实现时缺少验证边界。只有出现明确需求才重新考虑。

## 上游测试证据与本地验收

[Shaka：后一次 load 胜出、destroy 中断 load](https://github.com/shaka-project/shaka-player/blob/7bd1d5daf3b59e6509cf9af3da2014fdd8ad354c/test/player_load_graph_integration.js#L167-L194)；[Video.js：换源时取消旧 fallback](https://github.com/videojs/video.js/blob/8e4ec97eb9a38dc1e5571b2b4a996df387139f1f/test/unit/player.test.js#L388-L553)；[hls.js：一次停滞只报告一次](https://github.com/video-dev/hls.js/blob/abb6945bd29eadc04c25b2522528ca6aa619992f/tests/unit/controller/gap-controller.ts#L129-L160)；[LiveKit：解绑后的可见性观测测试](https://github.com/livekit/client-sdk-js/blob/7e2dc68a5650dac629c157ca1e5ec68117b218dc/src/room/track/RemoteVideoTrack.test.ts#L16-L97)，不是连接竞争测试。

WhepTS 优先验证：A 未完成即切 B；旧回复仅清理旧服务端资源、旧轨道和旧 play/getStats 不改变 B；关闭后不复活；多个故障源只调度一次重连；监听器移除或回调内调用 close 不破坏生命周期；暂停跨可见性切换保持；自动播放拒绝不触发建连重试。
