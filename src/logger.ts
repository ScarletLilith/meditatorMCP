/**
 * 结构化日志工具
 *
 * 输出到 stderr，不影响 MCP stdio 通信。
 * 日志格式：[ISO时间] [级别] [requestId] 消息  key=value
 *
 * 级别：INFO / WARN / ERROR
 */

export type LogLevel = "INFO" | "WARN" | "ERROR";
export type Loggable = Record<string, unknown>;

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, requestId: string | undefined, msg: string, extra?: Loggable): string {
  const parts = [
    `[${timestamp()}]`,
    `[${level}]`,
    requestId ? `[${requestId}]` : "",
    msg,
  ];

  if (extra && Object.keys(extra).length > 0) {
    const entries = Object.entries(extra).map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${val}`;
    });
    parts.push(entries.join("  "));
  }

  return parts.filter(Boolean).join(" ");
}

function write(level: LogLevel, requestId: string | undefined, msg: string, extra?: Loggable): void {
  const line = formatMessage(level, requestId, msg, extra);
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.error(line);
  }
}

export const logger = {
  info: (msg: string, extra?: Loggable) => write("INFO", undefined, msg, extra),
  warn: (msg: string, extra?: Loggable) => write("WARN", undefined, msg, extra),
  error: (msg: string, extra?: Loggable) => write("ERROR", undefined, msg, extra),

  /** 带 requestId 的版本，用于追踪单次工具调用 */
  withId: (requestId: string) => ({
    info: (msg: string, extra?: Loggable) => write("INFO", requestId, msg, extra),
    warn: (msg: string, extra?: Loggable) => write("WARN", requestId, msg, extra),
    error: (msg: string, extra?: Loggable) => write("ERROR", requestId, msg, extra),
  }),
};
