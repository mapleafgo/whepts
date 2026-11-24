import type { MonitorScheduler } from "./scheduler";
import type { MediaNotifier } from "~/types";
import { TaskPriority } from "./scheduler";

const STARTUP_VERIFICATION_MS = 500;
const STALL_CHECK_INTERVAL_MS = 5000;
const RECOVERY_DELAY_MS = 1000;
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * PlayMonitor 配置选项
 */
export interface PlayMonitorOptions {
  /** 媒体容器元素 */
  container: HTMLMediaElement;
  /** 事件发射器 */
  notify: MediaNotifier;
}

/**
 * 播放监控器
 *
 * 处理媒体元素播放逻辑和错误监控，包括：
 * - 自动播放、错误处理、播放验证和停滞检测
 * - Video 元素崩溃检测和自动恢复
 *
 * 使用调度器进行定时检查，与其他监控器共享计时器资源。
 */
export class PlayMonitor {
  private lastCurrentTime = 0;
  // 挂载后的第一次采样只建立基线：此时时钟往往刚起步，不足以判断停滞。
  private needsBaseline = false;
  private generation = 0;
  private playPending = false;
  private activeSource?: HTMLMediaElement["srcObject"];
  private recovering = false;
  private recoveryAttempts = 0;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private verificationTimer?: ReturnType<typeof setTimeout>;
  private unregisterMonitor?: () => void;
  private readonly scheduler: MonitorScheduler;

  constructor(
    private options: PlayMonitorOptions,
    scheduler: MonitorScheduler,
  ) {
    this.scheduler = scheduler;

    // 设置 video 元素错误监听器（保存引用以便在 destroy 时移除）
    this.container.addEventListener("error", (this.handleVideoError = () => this.onVideoError()));
  }

  /**
   * 获取媒体容器
   */
  private get container(): HTMLMediaElement {
    return this.options.container;
  }

  /**
   * Start playback on the element.
   * `freshStream` forces a real play() call because assigning srcObject restarts loading.
   */
  async play({ freshStream = false }: { freshStream?: boolean } = {}): Promise<void> {
    const stream = this.container.srcObject;
    // 同源轨道通知不应作废尚未完成的播放或启动校验。
    if (
      !freshStream &&
      this.activeSource === stream &&
      (this.playPending || (!this.container.paused && this.unregisterMonitor))
    )
      return;
    this.stopMonitoring();
    const generation = this.generation;
    this.activeSource = stream;
    const isCurrent = (): boolean =>
      this.generation === generation && this.container.srcObject === stream;
    // 赋值 srcObject 会重置加载状态，此时必须真正调用 play() 才能把新流带入播放。
    if (!freshStream && !this.container.paused) {
      this.startMonitoring();
      return;
    }

    this.playPending = true;
    try {
      await this.container.play();
    } catch (error) {
      if (!isCurrent()) return;
      const blocked = error instanceof DOMException && error.name === "NotAllowedError";
      this.options.notify("playback:failed", {
        code: blocked ? "autoplay-blocked" : "playback-error",
        reason: blocked ? "Autoplay requires user interaction" : "Unable to start playback",
        muted: this.container.muted,
      });
      return;
    } finally {
      if (this.generation === generation) this.playPending = false;
    }

    if (!isCurrent()) return;
    this.startMonitoring();
    this.verificationTimer = setTimeout(() => {
      if (isCurrent()) this.verifyPlayback();
    }, STARTUP_VERIFICATION_MS);
    this.options.notify("playback:started", { muted: this.container.muted });
  }

  /**
   * 验证 play() 调用后播放是否真正开始。
   */
  private verifyPlayback(): void {
    // 检查视频是否真正在播放
    if (this.container.paused) {
      this.options.notify("playback:stalled", {
        reason: "Playback verification failed: media is paused",
      });
      return;
    }

    // 媒体时钟可能由音频推进，不能据此判断视频已出帧。
    const quality = (this.container as HTMLVideoElement).getVideoPlaybackQuality?.();
    if (quality && quality.totalVideoFrames === quality.droppedVideoFrames) {
      this.options.notify("playback:stalled", { reason: "No video frames presented" });
      return;
    }

    // 检查 currentTime 是否在前进
    if (this.container.currentTime === 0) {
      this.options.notify("playback:stalled", {
        reason: "Playback verification failed: currentTime is not advancing",
      });
    }
  }

  /**
   * 启动播放停滞监控
   */
  private startMonitoring(): void {
    // 初始化 lastCurrentTime
    this.lastCurrentTime = this.container.currentTime;
    this.needsBaseline = true;

    // 注册监控任务（使用固定的类型名称作为 owner）
    this.unregisterMonitor = this.scheduler.register({
      interval: STALL_CHECK_INTERVAL_MS,
      owner: "play-monitor", // 固定的类型名称
      priority: TaskPriority.NORMAL,
      callback: () => this.checkStalled(),
    });
  }

  /** Stop pending playback recovery without touching the host's element. */
  invalidate(): void {
    this.generation++;
    this.playPending = false;
    this.activeSource = undefined;
    this.recovering = false;
    this.recoveryAttempts = 0;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    clearTimeout(this.verificationTimer);
    this.verificationTimer = undefined;
  }

  /**
   * 停止播放停滞监控
   */
  stopMonitoring(): void {
    this.invalidate();
    if (this.unregisterMonitor) {
      this.unregisterMonitor();
      this.unregisterMonitor = undefined;
    }
  }

  /**
   * 检查播放是否停滞
   */
  private checkStalled(): void {
    if (!this.activeSource || this.container.srcObject !== this.activeSource) {
      this.stopMonitoring();
      return;
    }

    const currentTime = this.container.currentTime;
    if (this.needsBaseline) {
      this.needsBaseline = false;
      this.lastCurrentTime = currentTime;
      return;
    }
    const timeAdvanced = currentTime - this.lastCurrentTime;

    // 如果 5 秒内时间前进少于 0.1 秒，认为已停滞
    if (timeAdvanced < 0.1 && !this.container.paused) {
      this.options.notify("playback:stalled", {
        reason: `Playback stalled: currentTime not advancing (advanced ${timeAdvanced.toFixed(2)}s in 5s)`,
      });
      return;
    }

    this.lastCurrentTime = currentTime;
    if (!this.container.paused && timeAdvanced >= 0.1) {
      const quality = (this.container as HTMLVideoElement).getVideoPlaybackQuality?.();
      if (!quality || quality.totalVideoFrames > quality.droppedVideoFrames)
        this.recoveryAttempts = 0;
    }
  }

  private handleVideoError?: (evt: Event) => void;

  private onVideoError(): void {
    const source = this.activeSource;
    if (!source || source !== this.container.srcObject || this.recovering) return;

    const attempts = this.recoveryAttempts;
    this.stopMonitoring();
    if (this.container.error?.code !== 3) {
      this.reportRecoveryFailure("playback-error", "Media element reported a playback error");
      return;
    }

    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      this.reportRecoveryFailure(
        "element-recovery-exhausted",
        "Media element recovery attempts were exhausted",
      );
      return;
    }
    this.recoveryAttempts = attempts;
    this.activeSource = source;
    this.recovering = true;
    this.scheduleRecovery(source, this.generation);
  }

  private scheduleRecovery(
    source: NonNullable<HTMLMediaElement["srcObject"]>,
    generation: number,
  ): void {
    // 让元素有时间释放解码资源，再重新挂载同一连接的流。
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recover(source, generation);
    }, RECOVERY_DELAY_MS);
  }

  private async recover(
    source: NonNullable<HTMLMediaElement["srcObject"]>,
    generation: number,
  ): Promise<void> {
    const current = (): boolean =>
      generation === this.generation && this.container.srcObject === source;
    if (!current()) return;
    this.recoveryAttempts++;

    try {
      this.container.srcObject = null;
      this.container.srcObject = source;
      await this.container.play();
    } catch (error) {
      if (!current()) return;
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.reportRecoveryFailure("autoplay-blocked", "Autoplay requires user interaction");
      } else if (this.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        this.scheduleRecovery(source, generation);
      } else {
        this.reportRecoveryFailure(
          "element-recovery-exhausted",
          "Media element recovery attempts were exhausted",
        );
      }
      return;
    }
    if (current()) {
      this.recovering = false;
      this.startMonitoring();
      this.options.notify("playback:started", { muted: this.container.muted });
    }
  }

  private reportRecoveryFailure(
    code: "playback-error" | "autoplay-blocked" | "element-recovery-exhausted",
    reason: string,
  ): void {
    this.stopMonitoring();
    this.options.notify("playback:failed", { code, reason, muted: this.container.muted });
  }

  /**
   * 移除错误监听器
   */
  destroy(): void {
    this.stopMonitoring();
    if (this.handleVideoError) {
      this.container.removeEventListener("error", this.handleVideoError);
      this.handleVideoError = undefined;
    }
  }
}
