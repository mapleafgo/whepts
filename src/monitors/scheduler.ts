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
  interval: number
  priority: TaskPriority
  status: TaskStatus
  callback: () => void | Promise<void>
  lastRun: number
  nextRun: number
}

/**
 * 监控调度器配置
 */
export interface SchedulerOptions {
  /** 基础调度间隔（毫秒），默认 1000ms */
  baseInterval?: number
  /** 单次调度最大执行任务数，默认 10 */
  maxTasksPerTick?: number
  /** 性能阈值：如果一帧执行超过此时间（毫秒），启用自适应降频，默认 16ms */
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
    this.baseInterval = options.baseInterval ?? 1000
    this.maxTasksPerTick = options.maxTasksPerTick ?? 10
    this.performanceThreshold = options.performanceThreshold ?? 16
    this.enableAdaptiveThrottling = options.enableAdaptiveThrottling ?? true
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

    const now = Date.now()

    // 创建或更新任务
    this.tasks.set(taskId, {
      id: taskId,
      interval,
      priority,
      status: TaskStatus.SCHEDULED,
      callback,
      lastRun: now - interval, // 立即执行一次
      nextRun: now,
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
      if (task.id.startsWith(owner) && task.status === TaskStatus.SCHEDULED) {
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
      if (task.id.startsWith(owner) && task.status === TaskStatus.PAUSED) {
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

    // 计算上一帧的执行时间
    const lastFrameDuration = this.lastTickTime > 0 ? now - this.lastTickTime : 0
    this.lastTickTime = now

    // 自适应降频
    if (this.enableAdaptiveThrottling) {
      this.updateThrottleLevel(lastFrameDuration)
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
  private updateThrottleLevel(frameDuration: number): void {
    if (frameDuration > this.performanceThreshold * 2) {
      // 严重超载，4x 降频
      this.throttleLevel = Math.min(this.throttleLevel + 1, 2)
    }
    else if (frameDuration > this.performanceThreshold) {
      // 轻微超载，2x 降频
      this.throttleLevel = Math.max(this.throttleLevel, 1)
    }
    else if (frameDuration < this.performanceThreshold * 0.5) {
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
      console.error(`[MonitorScheduler] Task ${task.id} error:`, error)
      // 错误任务继续调度，避免单次错误影响后续
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
