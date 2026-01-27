# WhepTS Player

基于 [mediamtx](https://github.com/bluenviron/mediamtx) 的 WebRTC WHEP 播放器，支持 ZLM 和 Mediamtx 的播放地址。

## 简介

本项目基于 [mediamtx 的 reader.js](https://github.com/bluenviron/mediamtx/blob/main/internal/servers/webrtc/reader.js) 编写，实现了对 ZLM (ZLMediaKit) 和 Mediamtx 的 WebRTC WHEP 协议播放地址的支持。

WebRTC WHEP (WebRTC HTTP Egress Protocol) 是一种用于从 WebRTC 服务器获取媒体流的协议，允许客户端通过 HTTP 请求获取实时音视频流。

## 功能特性

- 支持 ZLMediaKit 的 WHEP 播放地址
- 支持 Mediamtx 的 WHEP 播放地址
- 基于 WebRTC 的低延迟播放
- TypeScript 编写，类型安全
- 支持事件监听和错误处理
- 可配置的连接参数
- 自动断流检测与重连
- 支持动态更新播放地址（用于故障切换）
- 支持多种音视频编解码器
- 支持非公告编解码器自动检测（G.711 A-law、多声道 Opus、线性 PCM）
- 自适应流健康监测（初始高频检测，稳定后低频检测）
- 支持仅可视区域播放控制（IntersectionObserver，50% 阈值）
- 在 Chrome 上根据硬件支持 G711 和 H265 编解码器
- 自动 ICE 候选队列管理

## 安装

```bash
npm i whepts
```

或

```bash
pnpm add whepts
```

## 使用方法

### 基本用法

```typescript
import WebRTCWhep from 'whepts'

// 配置参数
const config = {
  url: 'https://your-server:port/index/api/whep?app={app}&stream={stream}', // WHEP 服务器地址
  container: document.getElementById('video') as HTMLMediaElement, // 视频播放容器
  lazyLoad: true, // 启用懒加载（自动暂停/恢复），默认：true
}

// 创建播放器实例
const player = new WebRTCWhep(config)

// 监听事件
player.on('state:change', ({ from, to }) => {
  console.log(`状态变化: ${from} → ${to}`)
})

player.on('error', (error) => {
  console.error('播放错误:', error.message, error.type)
})

player.on('track', (evt) => {
  console.log('接收到媒体轨道:', evt.track.kind)
})

// 播放器会自动开始播放
```

### 高级用法

```typescript
import WebRTCWhep from 'whepts'

// 配置参数
const config = {
  url: 'http://localhost:8889/{stream}/whep', // WHEP 服务器地址
  container: document.getElementById('video') as HTMLMediaElement, // 视频播放容器
  user: 'username', // 认证用户名（可选）
  pass: 'password', // 认证密码（可选）
  token: 'token', // 认证令牌（可选）
  iceServers: [ // ICE 服务器配置（可选）
    {
      urls: ['stun:stun.l.google.com:19302']
    }
  ],
  lazyLoad: true, // 启用懒加载（自动暂停/恢复），默认：true（可选）
}

// 创建播放器实例
const player = new WebRTCWhep(config)

// 监听所有事件
player.on('codecs:detected', (codecs) => {
  console.log('检测到的非公告编解码器:', codecs)
  // 可能包含: 'pcma/8000/2', 'multiopus/48000/6', 'L16/48000/2'
})

player.on('state:change', ({ from, to }) => {
  console.log(`状态: ${from} → ${to}`)
})

player.on('candidate', (candidate) => {
  console.log('ICE 候选:', candidate.candidate)
})

player.on('track', (evt) => {
  console.log('媒体轨道:', evt.track.kind)
})

player.on('error', (error) => {
  console.error('错误:', error.message, error.type)
})

player.on('close', () => {
  console.log('连接已关闭')
})

player.on('restart', () => {
  console.log('正在重连...')
})

// 检查流状态
console.log('流状态:', player.isRunning)

// 暂停播放
player.pause()

// 恢复播放
player.resume()

// 关闭播放器
player.close()
```

### 更新播放地址

当播放失败时，可以使用 `updateUrl()` 方法切换到新的播放地址：

```typescript
import WebRTCWhep from 'whepts'

const player = new WebRTCWhep({
  url: 'https://your-server:port/stream.whep',
  container: document.getElementById('video') as HTMLMediaElement,
})

// 监听错误事件
player.on('error', async (error) => {
  console.error('播放错误:', error.message)

  // 从服务器获取新的播放地址
  const newUrl = await fetchNewStreamUrl()

  // 使用新地址重新开始播放
  player.updateUrl(newUrl)
})

// 或者手动更新地址
const newStreamUrl = 'https://another-server:port/stream.whep'
player.updateUrl(newStreamUrl)
```

## 支持的播放地址格式

### ZLMediaKit

```text
https://zlmediakit.com/index/api/whep?app={app}&stream={stream}
```

### Mediamtx

```text
http://localhost:8889/{stream}/whep
```

## API

### WebRTCWhep 类

#### 构造函数

```typescript
WebRTCWhep(conf)
```

- `conf`: 配置对象
  - `url`: WHEP 服务器地址
  - `container`: HTML 媒体元素容器
  - `user`: 认证用户名（可选）
  - `pass`: 认证密码（可选）
  - `token`: 认证令牌（可选）
  - `iceServers`: ICE 服务器配置（可选）
  - `lazyLoad`: 启用懒加载（自动暂停/恢复），默认：true（可选）

#### 事件

```typescript
// 编解码器检测事件
player.on('codecs:detected', (codecs) => {
  console.log('检测到的非公告编解码器:', codecs)
})

// 状态变化事件
player.on('state:change', ({ from, to }) => {
  console.log(`状态: ${from} → ${to}`)
})

// ICE 候选事件
player.on('candidate', (candidate) => {
  console.log('ICE 候选:', candidate.candidate)
})

// 媒体轨道事件
player.on('track', (evt) => {
  console.log('媒体轨道:', evt.track.kind)
})

// 错误事件
player.on('error', (error) => {
  console.error('错误:', error.message, error.type)
})

// 连接关闭事件
player.on('close', () => {
  console.log('连接已关闭')
})

// 重连事件
player.on('restart', () => {
  console.log('正在重连...')
})
```

**事件类型：**
- `codecs:detected`: 检测到浏览器支持的非公告编解码器，包含编解码器列表
- `state:change`: 状态变化，包含 `from` 和 `to` 状态
- `candidate`: ICE 候选
- `track`: 媒体轨道
- `error`: 错误
- `close`: 连接关闭
- `restart`: 开始重连

#### 属性

- `state`: 当前状态 (`getting_codecs` | `running` | `restarting` | `closed` | `failed`)
- `isRunning`: 流是否正在运行
- `paused`: 播放器是否已暂停

#### 方法

- `close()`: 关闭播放器和所有资源
- `pause()`: 暂停播放
- `resume()`: 恢复播放
- `updateUrl(url)`: 更新播放地址并重新开始播放（用于播放失败时切换到新的 URL）
- `on(event, listener)`: 注册事件监听器

#### 错误类型

- `ErrorTypes.SIGNAL_ERROR`: 信令异常
- `ErrorTypes.STATE_ERROR`: 状态异常
- `ErrorTypes.NETWORK_ERROR`: 网络错误
- `ErrorTypes.MEDIA_ERROR`: 媒体错误
- `ErrorTypes.OTHER_ERROR`: 其他错误

## 构建

```bash
npm run build
```

## 开发

```bash
npm run dev
```

## 项目结构

```text
src/
├── index.ts          # 主要的 WebRTCWhep 类实现
└── utils/
    └── observer.ts   # 可见性监测工具
```

## 依赖

- TypeScript
- WebRTC API
- eventemitter3 - 事件发射器
- nanostores - 状态管理
- 相关构建工具 (Rollup, ESLint)

## 许可证

MIT
