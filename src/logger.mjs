/**
 * 极简结构化日志：单行输出，带时间戳、级别与任务标签，方便 `docker logs` / `journalctl` 过滤。
 *
 * 除了写标准输出，还会把每条记录交给可选的 `sink`，Web 控制台靠它做实时日志面板——
 * 日志只有一个出口，不会出现「界面看到的和文件里记的不一样」。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {object} [options]
 * @param {string} [options.level] 最低输出级别，取值 debug / info / warn / error。
 * @param {{level: string, tag: string, message: string, at: number, extra: unknown}} [options.sink]
 *   每条已被级别过滤保留的记录都会调用一次；sink 自身抛错会被吞掉，不能让它拖垮主循环。
 * @returns {object} 带 debug/info/warn/error 方法的 logger。
 */
export function createLogger(options = {}) {
  const threshold = LEVELS[options.level ?? process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;
  const sink = options.sink;

  const emit = (level, tag, message, extra) => {
    if (LEVELS[level] < threshold) return;
    const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5)];
    if (tag) parts.push(`[${tag}]`);
    parts.push(message);
    if (extra !== undefined) parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra));
    const line = parts.join(' ');
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
    if (sink) {
      try {
        sink({ level, tag: tag ?? '', message, at: Date.now(), extra });
      } catch {
        // 日志旁路（Web 推送、环形缓冲）出问题不能反过来影响抓取，这里明确吞掉。
      }
    }
  };

  return {
    /**
     * @param {string} message 日志正文。
     * @param {string} [tag] 任务或模块标签。
     * @param {unknown} [extra] 附加数据，对象会被 JSON 序列化。
     */
    debug: (message, tag, extra) => emit('debug', tag, message, extra),
    /**
     * @param {string} message 日志正文。
     * @param {string} [tag] 任务或模块标签。
     * @param {unknown} [extra] 附加数据，对象会被 JSON 序列化。
     */
    info: (message, tag, extra) => emit('info', tag, message, extra),
    /**
     * @param {string} message 日志正文。
     * @param {string} [tag] 任务或模块标签。
     * @param {unknown} [extra] 附加数据，对象会被 JSON 序列化。
     */
    warn: (message, tag, extra) => emit('warn', tag, message, extra),
    /**
     * @param {string} message 日志正文。
     * @param {string} [tag] 任务或模块标签。
     * @param {unknown} [extra] 附加数据，对象会被 JSON 序列化。
     */
    error: (message, tag, extra) => emit('error', tag, message, extra),
  };
}
