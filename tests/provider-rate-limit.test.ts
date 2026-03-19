import assert from "node:assert/strict";
import test from "node:test";

import {applyRateLimitCooldown, buildRateLimitedResult, clearRateLimitCooldowns, isConcurrentSessionRateLimited, maybeApplyRateLimitCooldown,} from "../lib/providers/rate-limit.ts";
import type {CheckResult, ProviderConfig} from "../lib/types/index.ts";

const baseConfig: ProviderConfig = {
  id: "config-1",
  name: "codexcn",
  type: "openai",
  endpoint: "https://api2.codexcn.com/v1/responses",
  model: "gpt-5.4",
  apiKey: "sk-test",
  is_maintenance: false,
  groupName: "cch",
};

function createRateLimitedResult(logMessage?: string): CheckResult {
  return {
    id: baseConfig.id,
    name: baseConfig.name,
    type: baseConfig.type,
    endpoint: baseConfig.endpoint,
    model: baseConfig.model,
    status: "error",
    latencyMs: 504,
    pingLatencyMs: 179,
    checkedAt: "2026-03-19T00:00:00.000Z",
    message:
      "Failed after 3 attempts. Last error: 并发 Session 超限：当前 3 个（限制：3 个）。请等待活跃 Session 完成",
    logMessage,
    groupName: "cch",
  };
}

test("rate limit detection matches concurrent session errors", () => {
  assert.equal(isConcurrentSessionRateLimited(createRateLimitedResult()), true);
  assert.equal(
    isConcurrentSessionRateLimited({
      ...createRateLimitedResult(),
      message: "empty_stream: upstream stream closed before first payload",
    }),
    false
  );
});

test("applying a rate limit cooldown downgrades the first error and records the cooldown window", () => {
  clearRateLimitCooldowns();

  const nowMs = Date.parse("2026-03-19T05:40:39+08:00");
  const transformed = applyRateLimitCooldown(
    createRateLimitedResult(
      JSON.stringify({
        data: {
          error: {
            reset_time: "2026-03-19T05:41:09+08:00",
          },
        },
      })
    ),
    nowMs
  );

  assert.equal(transformed.status, "degraded");
  assert.match(transformed.message, /冷却到/);
  assert.match(transformed.message, /最近错误/);

  const skipped = buildRateLimitedResult(baseConfig, nowMs + 10_000);
  assert.ok(skipped);
  assert.equal(skipped?.status, "degraded");
  assert.match(skipped?.message || "", /本轮跳过主动探测/);
  assert.equal(skipped?.latencyMs, 504);
  assert.equal(skipped?.pingLatencyMs, 179);
});

test("cooldown expires automatically after the reset time", () => {
  clearRateLimitCooldowns();

  const nowMs = Date.parse("2026-03-19T05:40:39+08:00");
  applyRateLimitCooldown(
    createRateLimitedResult(
      JSON.stringify({
        responseHeaders: {
          "retry-after": "5",
        },
      })
    ),
    nowMs
  );

  const skipped = buildRateLimitedResult(baseConfig, nowMs + 6_000);
  assert.equal(skipped, null);
});

test("maybeApplyRateLimitCooldown downgrades concurrent session errors only once", () => {
  clearRateLimitCooldowns();

  const nowMs = Date.parse("2026-03-19T05:40:39+08:00");
  const first = maybeApplyRateLimitCooldown(
    createRateLimitedResult(
      JSON.stringify({
        responseHeaders: {
          "x-ratelimit-reset": "1773870069",
        },
      })
    ),
    nowMs
  );

  assert.equal(first.status, "degraded");
  assert.match(first.message, /冷却到/);

  const second = maybeApplyRateLimitCooldown(first, nowMs + 10_000);
  assert.equal(second.status, "degraded");
  assert.equal(second.message, first.message);
});
