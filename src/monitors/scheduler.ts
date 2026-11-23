/**
 * 任务优先级
 */
export enum TaskPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3,
}

/**
 * 任务状态
 */
enum TaskStatus {
  SCHEDULED = 'scheduled',
  RUNNING = 'running',
  PAUSED = 'paused',
}

/**
 * 任务接口
 */
interface Task {
  id: string
  owner: string
  interval: number
  priority: TaskPriority
  status: TaskStatus
  callback: () => void | Promise<void>
  lastRun: number
  nextRun: number
}

const DEFAULT_SCHEDULER_OPTIONS = {
  baseInterval: 1000,
  maxTasksPerTick: 10,
  performanceThreshold: 16,
  enableAdaptiveThrottling: true,
} satisfies Required<SchedulerOptions>

/**
 * 监控调度器配置
 */
export interface SchedulerOptions {
  /** 基础调度间隔（毫秒），默认 1000ms */
  baseInterval?: number
  /** 单次调度最大执行任务数，默认 10 */
  maxTasksPerTick?: number
  /** 调度实际间隔超出计划间隔的阈值（毫秒），默认 16ms */
  performanceThreshold?: number
  /** 是否启用自适应降频，默认 true */
  enableAdaptiveThrottling?: boolean
}

/**
 * 任务注册选项
 */
export interface RegisterTaskOptions {
  /** 执行间隔（毫秒） */
  interval: number
  /** 等待完整间隔再首次执行。 */
  deferFirstRun?: boolean
  /** 任务所有者标识（用于批量暂停/恢复） */
  owner: string
  /** 任务优先级，默认 NORMAL */
  priority?: TaskPriority
  /** 执行回调 */
  callback: () => void | Promise<void>
}

/**
 * 高性能监控调度器
 *
 * 轻量级设计，专为播放器内部少量监控任务优化。
 *
 * 核心特性：
 * - 优先级队列：高优先级任务优先执行
 * - 智能降频：检测性能压力，自动降低全局频率
 * - 防重复注册：相同 owner + interval 自动替换旧任务
 * - 暂停/恢复：支持按 owner 批量暂停任务
 */
export class MonitorScheduler {
  private timer?: ReturnType<typeof setInterval>
  private tasks: Map<string, Task> = new Map()
  private currentTick = 0
  private lastTickTime = 0
  private throttleLevel = 0 // 0=正常, 1=2x降频, 2=4x降频
  private isRunning = false

  private readonly baseInterval: number
  private readonly maxTasksPerTick: number
  private readonly performanceThreshold: number
  private readonly enableAdaptiveThrottling: boolean

  constructor(options: SchedulerOptions = {}) {
    this.baseInterval = options.baseInterval ?? DEFAULT_SCHEDULER_OPTIONS.baseInterval
    this.maxTasksPerTick = options.maxTasksPerTick ?? DEFAULT_SCHEDULER_OPTIONS.maxTasksPerTick
    this.performanceThreshold = options.performanceThreshold ?? DEFAULT_SCHEDULER_OPTIONS.performanceThreshold
    this.enableAdaptiveThrottling = options.enableAdaptiveThrottling ?? DEFAULT_SCHEDULER_OPTIONS.enableAdaptiveThrottling
  }

  /**
   * 注册任务
   *
   * 如果已存在相同 owner 的任务，会自动替换。
   *
   * @returns 取消注册函数
   */
  register(options: RegisterTaskOptions): () => void {
    const { interval, owner, priority = TaskPriority.NORMAL, callback } = options
    const taskId = `${owner}-${interval}`
    // 同一 owner 只保留最新任务，避免间隔切换时留下孤儿任务。
    for (const [id, task] of this.tasks) {
      if (task.owner === owner && id !== taskId)
        this.tasks.delete(id)
    }

    const now = Date.now()

    // 创建或更新任务
    this.tasks.set(taskId, {
      id: taskId,
      owner,
      interval,
      priority,
      status: TaskStatus.SCHEDULED,
      callback,
      lastRun: options.deferFirstRun ? now : now - interval,
      nextRun: options.deferFirstRun ? now + interval : now,
    })

    // 启动调度器
    this.ensureStarted()

    // 返回取消函数
    return () => {
      this.tasks.delete(taskId)
      if (this.tasks.size === 0) {
        this.stop()
      }
    }
  }

  /**
   * 暂停指定 owner 的所有任务
   */
  pauseByOwner(owner: string): void {
    for (const task of this.tasks.values()) {
      if (task.owner === owner && task.status === TaskStatus.SCHEDULED) {
        task.status = TaskStatus.PAUSED
      }
    }
  }

  /**
   * 恢复指定 owner 的所有任务
   */
  resumeByOwner(owner: string): void {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.owner === owner && task.status === TaskStatus.PAUSED) {
        task.status = TaskStatus.SCHEDULED
        task.nextRun = now + task.interval
      }
    }
  }

  /**
   * 启动调度器
   */
  private ensureStarted(): void {
    if (this.isRunning)
      return

    this.isRunning = true
    this.lastTickTime = Date.now()
    this.timer = setInterval(() => {
      this.tick()
    }, this.baseInterval)
  }

  /**
   * 停止调度器
   */
  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.isRunning = false
    this.throttleLevel = 0
  }

  /**
   * 主调度循环
   */
  private tick(): void {
    const now = Date.now()

    // 正常的计时器间隔不计入调度延迟。
    const tickDelay = this.lastTickTime > 0 ? Math.max(0, now - this.lastTickTime - this.baseInterval) : 0
    this.lastTickTime = now

    // 自适应降频
    if (this.enableAdaptiveThrottling) {
      this.updateThrottleLevel(tickDelay)
    }

    // 获取需要执行的任务
    const tasksToRun = this.getTasksToRun(now)

    if (tasksToRun.length === 0)
      return

    // 执行任务
    this.runTasks(tasksToRun, now)

    this.currentTick++
  }

  /**
   * 更新降频级别
   */
  private updateThrottleLevel(tickDelay: number): void {
    if (tickDelay > this.performanceThreshold * 2) {
      // 严重超载，4x 降频
      this.throttleLevel = Math.min(this.throttleLevel + 1, 2)
    }
    else if (tickDelay > this.performanceThreshold) {
      // 轻微超载，2x 降频
      this.throttleLevel = Math.max(this.throttleLevel, 1)
    }
    else if (tickDelay < this.performanceThreshold * 0.5) {
      // 性能良好，降低降频级别
      this.throttleLevel = Math.max(this.throttleLevel - 1, 0)
    }
  }

  /**
   * 获取当前需要执行的任务
   *
   * 按优先级排序，并考虑降频级别
   */
  private getTasksToRun(now: number): Task[] {
    const tasksToRun: Task[] = []
    const throttleMultiplier = 2 ** this.throttleLevel

    for (const task of this.tasks.values()) {
      // 跳过暂停的任务
      if (task.status !== TaskStatus.SCHEDULED)
        continue

      // 计算有效间隔（考虑降频）
      const effectiveInterval = task.interval * throttleMultiplier

      if (now - task.lastRun >= effectiveInterval) {
        tasksToRun.push(task)
      }
    }

    // 按优先级排序（高优先级先执行）
    tasksToRun.sort((a, b) => b.priority - a.priority)

    return tasksToRun
  }

  /**
   * 执行任务列表
   *
   * 限制每次执行的任务数量，避免阻塞
   */
  private runTasks(tasks: Task[], now: number): void {
    const maxTasks = Math.min(tasks.length, this.maxTasksPerTick)

    for (let i = 0; i < maxTasks; i++) {
      const task = tasks[i]
      this.runTask(task, now)
    }
  }

  /**
   * 执行单个任务
   */
  private async runTask(task: Task, now: number): Promise<void> {
    task.status = TaskStatus.RUNNING

    try {
      await task.callback()
      task.lastRun = now
      task.nextRun = now + task.interval
      task.status = TaskStatus.SCHEDULED
    }
    catch (error) {
      console.warn('[MonitorScheduler] Task failed', { taskId: task.id, error: error instanceof Error ? error.name : 'unknown' })
      // 失败仍推进节奏，避免同一个出错任务按每次 tick 反复重跑。
      task.lastRun = now
      task.nextRun = now + task.interval
      task.status = TaskStatus.SCHEDULED
    }
  }

  /**
   * 清理所有任务
   */
  destroy(): void {
    this.stop()
    this.tasks.clear()
    this.currentTick = 0
  }

  /**
   * 获取调度器状态（用于调试）
   */
  getStatus(): {
    taskCount: number
    throttleLevel: number
    currentTick: number
  } {
    return {
      taskCount: this.tasks.size,
      throttleLevel: this.throttleLevel,
      currentTick: this.currentTick,
    }
  }
}
