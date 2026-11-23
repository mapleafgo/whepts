import type { MonitorScheduler } from "./scheduler";
import type { MediaNotifier } from "~/types";
import { TaskPriority } from "./scheduler";

const FLOW_SAMPLE_INTERVAL_MS = 5000;
const FLOW_STABILIZATION_MS = 30000;

/**
 * FlowMonitor 配置选项
 */
export interface FlowMonitorOptions {
  /** 基础检查间隔（毫秒），初始阶段使用 */
  interval?: number;
  /** 稳定后的检查间隔（毫秒），默认为 interval 的 2 倍 */
  stableInterval?: number;
  /** 连续无进度的最大次数，超过则判定为断流，默认为 3 */
  maxNoProgress?: number;
  /** 稳定时间（毫秒），超过此时间后降低检查频率，默认为 30000（30秒） */
  stabilizationTime?: number;
  /** 事件发射器 */
  notify: MediaNotifier;
  onTimeout: (pc: RTCPeerConnection, elapsedMs: number) => void;
  onSampleFailed: (pc: RTCPeerConnection, errorName: string) => void;
  onProgress: (pc: RTCPeerConnection) => void;
}

/**
 * 流量监控器
 *
 * 监控 WebRTC 视频流的数据传输状态，通过检测视频接收字节数是否增长来判定是否断流。
 *
 * 性能优化特性：
 * - 自适应轮询：初始阶段高频检查，稳定后降低频率
 * - 容错机制：连续多次无进度才判定断流，避免误判
 * - 持续监控：即使视频不可见，也保持监控以确保连接健康
 * - 专注视频：只监控视频流，不监控音频流
 */
export class FlowMonitor {
  private readonly baseInterval: number;
  private readonly stableInterval: number;
  private readonly maxNoProgress: number;
  private readonly stabilizationTime: number;
  private readonly scheduler: MonitorScheduler;

  private lastBytesReceived = new Map<string, number>();
  private unregisterMonitor?: () => void;
  private pc?: RTCPeerConnection;
  private generation = 0;
  private visibilityGeneration = 0;
  private sampleTimeout?: ReturnType<typeof setTimeout>;
  private page?: Document;
  private onVisibilityChange = (): void => {
    this.visibilityGeneration++;
    this.reset();
  };

  private scheduledInterval?: number;
  private lastSampleAt?: number;

  // 状态跟踪
  private consecutiveNoProgress: number = 0;
  private startTime: number = 0;

  constructor(
    private options: FlowMonitorOptions,
    scheduler: MonitorScheduler,
  ) {
    this.scheduler = scheduler;
    this.baseInterval = options.interval ?? FLOW_SAMPLE_INTERVAL_MS;
    this.stableInterval = options.stableInterval || this.baseInterval * 2;
    this.maxNoProgress = options.maxNoProgress || 3;
    this.stabilizationTime = options.stabilizationTime || FLOW_STABILIZATION_MS;
  }

  /**
   * 启动断流检测
   */
  start(pc?: RTCPeerConnection): void {
    if (!pc || this.pc === pc) {
      return;
    }
    this.stop();
    this.pc = pc;
    this.page = typeof document === "undefined" ? undefined : document;
    this.page?.addEventListener("visibilitychange", this.onVisibilityChange);
    this.reset();
    this.startTime = Date.now();
    this.scheduleCheck();
  }

  /**
   * 停止断流检测并清理资源
   */
  stop(): void {
    this.generation++;
    clearTimeout(this.sampleTimeout);
    this.sampleTimeout = undefined;
    this.page?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.page = undefined;
    this.scheduledInterval = undefined;
    if (this.unregisterMonitor) {
      this.unregisterMonitor();
      this.unregisterMonitor = undefined;
    }
    this.pc = undefined;
  }

  /**
   * 重置检测状态
   */
  reset(): void {
    this.consecutiveNoProgress = 0;
    this.lastBytesReceived.clear();
    this.lastSampleAt = undefined;
  }

  /**
   * 调度检查任务
   */
  private scheduleCheck(deferFirstRun = false): void {
    // 取消旧任务
    if (this.unregisterMonitor) {
      this.unregisterMonitor();
    }

    const interval = this.getNextCheckInterval();
    this.scheduledInterval = interval;

    // 注册新任务（使用固定的类型名称作为 owner）
    this.unregisterMonitor = this.scheduler.register({
      interval,
      deferFirstRun,
      owner: "flow-monitor", // 固定的类型名称
      priority: TaskPriority.HIGH,
      callback: () => this.performCheck(),
    });
  }

  /**
   * 执行流状态检查
   */
  private async performCheck(): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.connectionState !== "connected" || this.page?.hidden) return;

    const generation = this.generation;
    await this.checkFlowState(pc, generation);
    if (generation === this.generation && this.getNextCheckInterval() !== this.scheduledInterval)
      this.scheduleCheck(true);
  }

  /**
   * 计算下次检查间隔
   */
  private getNextCheckInterval(): number {
    const elapsedTime = Date.now() - this.startTime;
    return elapsedTime > this.stabilizationTime ? this.stableInterval : this.baseInterval;
  }

  /**
   * 检测流状态（通过接收字节数判断是否断流）
   */
  private async checkFlowState(pc: RTCPeerConnection, generation: number): Promise<void> {
    const visibilityGeneration = this.visibilityGeneration;
    const startedAt = Date.now();
    const measuredStart = performance.now();
    let expired = false;
    // getStats 不可取消；超时后丢弃结果，但仍等原调用结算再采样。
    const expire = (): void => {
      if (expired || generation !== this.generation) return;
      expired = true;
      this.reset();
      if (visibilityGeneration === this.visibilityGeneration && pc.connectionState === "connected")
        this.options.onTimeout(pc, performance.now() - measuredStart);
    };
    const timeout = setTimeout(expire, this.baseInterval);
    this.sampleTimeout = timeout;
    const { bytes: currentBytes, errorName } = await this.getReceivedBytes(pc);
    clearTimeout(timeout);
    if (generation !== this.generation) return;
    this.sampleTimeout = undefined;
    if (expired || Date.now() - startedAt >= this.baseInterval) {
      expire();
      return;
    }
    if (visibilityGeneration !== this.visibilityGeneration) return;
    // 统计失败不等于断流，也不能当作空样本；上报后等下一次采样重建基线。
    if (errorName !== undefined) {
      this.reset();
      if (pc.connectionState === "connected") this.options.onSampleFailed(pc, errorName);
      return;
    }
    if (pc.connectionState !== "connected") return;

    const interval = this.scheduledInterval ?? this.baseInterval;
    const gap = this.lastSampleAt === undefined ? 0 : startedAt - this.lastSampleAt;
    // 长时间未采样时不延续休眠前的停滞计数。
    if (gap < 0 || gap > interval * 4) this.reset();
    this.lastSampleAt = startedAt;

    const previous = this.lastBytesReceived;
    this.lastBytesReceived = currentBytes;
    if ([...currentBytes].some(([id, bytes]) => previous.has(id) && bytes > previous.get(id)!))
      this.options.onProgress(pc);
    // 报告增减或计数重置时重新建立基线，避免把不可比较的样本判为停滞。
    if (
      currentBytes.size === 0 ||
      currentBytes.size !== previous.size ||
      [...currentBytes].some(([id, bytes]) => previous.get(id) !== bytes)
    ) {
      this.consecutiveNoProgress = 0;
      return;
    }
    this.handleNoProgress();
  }

  private async getReceivedBytes(
    pc: RTCPeerConnection,
  ): Promise<{ bytes: Map<string, number>; errorName?: string }> {
    const videoBytes = new Map<string, number>();
    try {
      const stats = await pc.getStats();
      stats.forEach((stat) => {
        if (stat.type !== "inbound-rtp") return;
        const inbound = stat as RTCInboundRtpStreamStats;
        if (
          inbound.kind === "video" &&
          typeof inbound.bytesReceived === "number" &&
          Number.isFinite(inbound.bytesReceived) &&
          inbound.bytesReceived >= 0
        )
          videoBytes.set(inbound.id, inbound.bytesReceived);
      });
    } catch (error) {
      videoBytes.clear();
      return { bytes: videoBytes, errorName: error instanceof Error ? error.name : "unknown" };
    }
    return { bytes: videoBytes };
  }

  /**
   * 处理无进度情况
   */
  private handleNoProgress(): void {
    this.consecutiveNoProgress++;

    if (this.consecutiveNoProgress >= this.maxNoProgress) {
      this.triggerStreamError();
      this.consecutiveNoProgress = 0;
    }
  }

  /**
   * 触发断流停滞事件
   */
  private triggerStreamError(): void {
    this.options.notify("flow:stalled", {
      reason: "Stream interrupted: video flow stalled",
    });
  }
}
