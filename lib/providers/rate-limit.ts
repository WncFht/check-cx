import type {CheckResult, ProviderConfig} from "../types";

const DEFAULT_COOLDOWN_MS = 60_000;

interface CooldownEntry {
  untilMs: number;
  reason: string;
  latencyMs: number | null;
  pingLatencyMs: number | null;
  logMessage?: string;
}

const cooldowns = new Map<string, CooldownEntry>();

function formatCooldownDeadline(untilMs: number): string {
  return new Date(untilMs).toLocaleString("zh-CN", {hour12: false});
}

function parseRateLimitDetail(raw: string | undefined): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function walkForKey(value: unknown, predicate: (key: string, value: unknown) => boolean): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => walkForKey(item, predicate));
  }

  if (typeof value !== "object") {
    return [];
  }

  const found: unknown[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (predicate(key, nested)) {
      found.push(nested);
    }
    found.push(...walkForKey(nested, predicate));
  }
  return found;
}

function parseCooldownUntilMs(detail: unknown, nowMs: number): number | null {
  const resetTimes = walkForKey(
    detail,
    (key, value) => key === "reset_time" && typeof value === "string"
  );
  for (const value of resetTimes) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const retryAfters = walkForKey(
    detail,
    (key, value) => key.toLowerCase() === "retry-after" && (typeof value === "string" || typeof value === "number")
  );
  for (const value of retryAfters) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return nowMs + seconds * 1000;
    }
  }

  const resetHeaders = walkForKey(
    detail,
    (key, value) => key.toLowerCase() === "x-ratelimit-reset" && (typeof value === "string" || typeof value === "number")
  );
  for (const value of resetHeaders) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      const normalized = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return normalized;
    }
  }

  return null;
}

export function isConcurrentSessionRateLimited(result: CheckResult): boolean {
  const haystack = `${result.message}\n${result.logMessage || ""}`;
  return /并发 Session 超限|concurrent_sessions|rate_limit_exceeded/i.test(haystack);
}

export function clearRateLimitCooldowns(): void {
  cooldowns.clear();
}

export function getRateLimitCooldown(configId: string, nowMs = Date.now()): CooldownEntry | null {
  const cooldown = cooldowns.get(configId);
  if (!cooldown) {
    return null;
  }

  if (cooldown.untilMs <= nowMs) {
    cooldowns.delete(configId);
    return null;
  }

  return cooldown;
}

export function applyRateLimitCooldown(result: CheckResult, nowMs = Date.now()): CheckResult {
  const detail = parseRateLimitDetail(result.logMessage);
  const untilMs = parseCooldownUntilMs(detail, nowMs) ?? nowMs + DEFAULT_COOLDOWN_MS;
  const cooldownReason = `上游并发 Session 已满，冷却到 ${formatCooldownDeadline(untilMs)}`;
  cooldowns.set(result.id, {
    untilMs,
    reason: cooldownReason,
    latencyMs: result.latencyMs,
    pingLatencyMs: result.pingLatencyMs,
    logMessage: result.logMessage,
  });

  return {
    ...result,
    status: "degraded",
    message: `${cooldownReason}。最近错误：${result.message}`,
  };
}

export function maybeApplyRateLimitCooldown(
  result: CheckResult,
  nowMs = Date.now()
): CheckResult {
  if (result.status === "degraded") {
    return result;
  }

  if (!isConcurrentSessionRateLimited(result)) {
    return result;
  }

  return applyRateLimitCooldown(result, nowMs);
}

export function buildRateLimitedResult(
  config: ProviderConfig,
  nowMs = Date.now()
): CheckResult | null {
  const cooldown = getRateLimitCooldown(config.id, nowMs);
  if (!cooldown) {
    return null;
  }

  return {
    id: config.id,
    name: config.name,
    type: config.type,
    endpoint: config.endpoint,
    model: config.model,
    status: "degraded",
    latencyMs: cooldown.latencyMs,
    pingLatencyMs: cooldown.pingLatencyMs,
    checkedAt: new Date(nowMs).toISOString(),
    message: `${cooldown.reason}，本轮跳过主动探测`,
    logMessage: cooldown.logMessage,
    groupName: config.groupName || null,
  };
}
