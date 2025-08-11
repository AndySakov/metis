export type LogLevel = "debug" | "info" | "warn" | "error";

function baseLog(
  component: string,
  level: LogLevel,
  event: string,
  details?: Record<string, unknown>
) {
  try {
    const payload = {
      ts: new Date().toISOString(),
      level,
      component,
      event,
      ...(details ? { details } : {}),
    };
    // Ensure it never throws
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  } catch {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), level, component, event })
    );
  }
}

export function createLogger(component: string) {
  return {
    debug(event: string, details?: Record<string, unknown>) {
      baseLog(component, "debug", event, details);
    },
    info(event: string, details?: Record<string, unknown>) {
      baseLog(component, "info", event, details);
    },
    warn(event: string, details?: Record<string, unknown>) {
      baseLog(component, "warn", event, details);
    },
    error(event: string, details?: Record<string, unknown>) {
      baseLog(component, "error", event, details);
    },
  } as const;
}
