# QWEN.md - WhepTS Player 项目上下文

## 项目概述

**WhepTS Player** 是一个基于 [mediamtx](https://github.com/bluenviron/mediamtx) 的 WebRTC WHEP (WebRTC HTTP Egress Protocol) 播放器，支持 ZLMediaKit 和 Mediamtx 的播放地址。该项目使用 TypeScript 编写，提供低延迟的实时音视频流播放功能。

### 核心功能

- 支持 ZLMediaKit 和 Mediamtx 的 WHEP 播放地址
- 基于 WebRTC 的低延迟播放
- 类型安全的 TypeScript 实现
- 事件监听和错误处理机制
- 可配置的连接参数
- 自动断流检测与重连功能
- 支持多种音视频编解码器
- 支持仅可视区域播放控制（通过 `VisibilityObserver`）
- 在 Chrome 上根据硬件支持 G711 和 H265 编解码器

## 技术栈与依赖

- **语言**: TypeScript
- **构建工具**: Rollup
- **包管理器**: pnpm
- **代码规范**: ESLint (使用 @antfu/eslint-config)
- **核心 API**: WebRTC API
- **开发依赖**:
  - `@antfu/eslint-config`
  - `@rollup/plugin-commonjs`
  - `@rollup/plugin-eslint`
  - `@rollup/plugin-terser`
  - `@rollup/plugin-typescript`
  - `@types/node`
  - `rollup`
  - `rollup-plugin-delete`
  - `tslib`
  - `typescript`

## 项目结构

```
src/
├── index.ts          # 主要的 WebRTCWhep 类实现
└── utils/
    └── observer.ts   # 可见性监测工具
```

## 主要代码文件

### `src/index.ts`

这是项目的核心文件，实现了 `WebRTCWhep` 类，负责处理 WebRTC 连接、WHEP 协议交互、媒体流处理等主要功能。关键特性包括：

- **配置接口**: `Conf` 接口定义了播放器的配置选项，包括 WHEP 服务器地址、媒体容器、认证信息、ICE 服务器配置等。
- **错误处理**: 定义了 `WebRTCError` 类和 `ErrorTypes` 常量，用于处理不同类型的错误（信令、状态、网络、媒体等）。
- **连接管理**: 实现了与 WHEP 服务器的连接、发送 offer、接收 answer、处理 ICE 候选等流程。
- **编解码器支持**: 包含了对非标准编解码器（如 PCMA/PCMU、multiopus、L16 等）的支持逻辑。
- **断流检测**: 通过 `getStats()` 监控接收字节数，实现断流检测和自动重连。
- **可见性控制**: 与 `VisibilityObserver` 集成，实现仅在元素可见时播放的功能。

### `src/utils/observer.ts`

实现了 `VisibilityObserver` 类，使用 `IntersectionObserver` API 来监测媒体元素的可见性，以便在元素进入或离开视口时暂停或恢复播放。

## 构建与开发

### 构建命令

- `npm run build` - 生产环境构建（压缩代码）
- `npm run build:debug` - 开发环境构建（保留源映射）

### 开发命令

- `npm run dev` - 开发模式（如果 package.json 中有定义）
- `npm run lint` - 代码检查
- `npm run lint:fix` - 自动修复代码问题

### 构建配置

- **Rollup**: 使用 `rollup.config.ts` 进行构建配置，输出格式为 ES 模块，目标文件为 `dist/index.js`。
- **TypeScript**: 使用 `tsconfig.json` 进行编译配置，目标为 ES2020，启用严格模式和类型检查。
- **ESLint**: 使用 `eslint.config.ts` 进行代码规范检查，基于 @antfu/eslint-config。

## API 使用

### WebRTCWhep 类

#### 构造函数

```typescript
WebRTCWhep(conf: Conf)
```

- `conf`: 配置对象，包含 `url`、`container`、`user`、`pass`、`token`、`iceServers`、`onError` 等属性。

#### 属性

- `isRunning`: 检查流是否正在运行
- `paused`: 检查播放器是否已暂停

#### 方法

- `close()`: 关闭播放器和所有资源
- `pause()`: 暂停播放
- `resume()`: 恢复播放

## 开发约定

- 代码使用 TypeScript 编写，遵循严格的类型检查。
- 使用 ESLint 进行代码风格和质量检查。
- 使用 Rollup 进行模块打包。
- 代码结构清晰，核心逻辑集中在 `src/index.ts`，工具类在 `src/utils/` 目录下。
- 错误处理采用自定义的 `WebRTCError` 类，便于区分不同类型的错误。
- 支持自动断流检测和重连，提高播放稳定性。
- 支持可见性控制，优化资源使用。

## 许可证

MIT