# 播放器监听器异常隔离调研（第 1 项）

**结论：捕获监听器的同步异常还不够，处理该异常的路径也不能把二次异常抛回派发循环。** 对 WhepTS 的 `diagnostic` 事件而言，即使监听器抛出一个 `name` getter 也会抛错的 `Error`，同一次派发中后续监听器仍应运行；不应因该失败再派发 `listener-error`。本文仅做源码与规范调研，不修改产品或测试。

## 播放器一手源码

| 实现 | 异常隔离边界 | 日志二次抛错与重入 |
| --- | --- | --- |
| [Shaka Player v4.16.0：FakeEventTarget.dispatchEvent](https://github.com/shaka-project/shaka-player/blob/v4.16.0/lib/util/fake_event_target.js#L113-L139) | 在循环里逐个调用监听器，`try/catch` 包住每个监听器，而不是整次派发。 | `catch` 直接读取 `exception.message` 和 `exception.stack` 作为日志参数；若这些 getter 抛错，异常可在调用 logger 前逃逸。这是同类风险，不是 Shaka 会读 `name` 的证据。源码注释另称 “events can be re-dispatched from handlers”，因此每轮重设 target/currentTarget；这不保护日志路径。 |
| [Video.js v8.23.4：自有事件 dispatcher](https://github.com/videojs/video.js/blob/v8.23.4/src/js/utils/events.js#L294-L321) | 用 `handlers.slice(0)` 复制监听器列表，逐个 `try/catch`；显式停止立即传播仍会结束循环。 | `catch` 调用 `log.error(e)`，该调用点未显式读取 `name`，也未另行捕获 logger 异常；不能据此保证日志链路永不抛错。复制列表处理派发期间增删监听器，并非阻止嵌套派发。 |
| [hls.js v1.6.13：emit / trigger](https://github.com/video-dev/hls.js/blob/v1.6.13/src/hls.ts#L381-L423) | `emit` 交给 [EventEmitter3 5.0.1 的循环](https://github.com/primus/eventemitter3/blob/5.0.1/index.js#L197-L212)，后者直接调用回调。非 debug 的 `trigger` 捕获的是整次 emit 的异常，不能恢复已经中断的监听器迭代；debug 路径不捕获。依赖版本见 [hls.js 包清单](https://github.com/video-dev/hls.js/blob/v1.6.13/package.json#L107)。 | `catch` 读取 `error.message`，之后才检查 `triggeringException`；源码注释 “Prevent recursion in error event handlers that throw” 指的是防止再次上报 ERROR，不是确保后续监听器运行，也兜不住前面的 getter。 |

## 适用规范

- [WHATWG DOM：inner invoke](https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke) 在逐个监听器调用中规定：“If this throws an exception … Report exception”，然后继续算法；异常本身不会设置立即停止传播标志。它把报告交给宿主，不要求播放器读取抛出对象的属性。DOM 是行为参照，不直接约束 WhepTS 的 EventEmitter API。
- [WHATWG DOM：dispatchEvent](https://dom.spec.whatwg.org/#dom-eventtarget-dispatchevent) 在同一个 Event 对象的 dispatch flag 已设置时抛出 `InvalidStateError`。这不是禁止监听器派发另一个 Event 对象，也不是异常上报防递归。
- [ECMAScript：OrdinaryGet](https://tc39.es/ecma262/#sec-ordinaryget) 对访问器属性执行 “Return ? Call(getter, receiver)”。因此即使对象通过 `instanceof Error`，读取 `error.name` 也可能执行用户 getter 并传播其异常；可选链不会捕获 getter 的异常。

## 对 WhepTS 第 1 项的意义

1. **异常隔离**：当前 [监听器包装](../../src/whep.ts#L455-L468) 已逐监听器捕获同步异常，但它在 `catch` 中调用报告函数。若报告函数抛错，包装本身仍会抛给 emitter，导致同轮后续监听器被跳过。
2. **日志读取二次抛错**：[报告函数](../../src/whep.ts#L439-L450) 在判断事件是否为 `diagnostic` 之前就读取 `error.name`。诊断分支只作调试日志，getter 却会在调用 logger 之前执行并可能抛错；不能把生产构建剥离 console 等同于保证报告代码安全返回。固定脱敏文本（不检查原异常）或独立防护名称提取及日志调用，是满足连续派发的思路，不是本次产品改动。
3. **重入（reentrancy）**：监听器、getter 或报告机制在当前派发尚未结束时主动触发另一轮派发，才是重入；getter 只抛错无须任何嵌套派发就能触发本项。现有 `event !== "diagnostic"` 只阻止因诊断监听器失败而自动派发 `listener-error`，不能防止读取属性时抛错，也不定义一般的嵌套派发政策。

**验收区分（未实施）**：先注册一个会抛出带抛错 `name` getter 的 Error 的诊断监听器，再注册记录收到事件的监听器。单次同步派发应正常返回，后者恰好收到一次原诊断，不产生新的 `listener-error`。嵌套派发或异步 Promise 拒绝应单独验证，不与本项混测。以上是源码和规范结论，不是对播放器运行测试通过的声明。
