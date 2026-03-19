/**
 * Provider 检查统一入口
 */

import pLimit from "p-limit";
import type { CheckResult, ProviderConfig } from "../types";
import { getErrorMessage, getSanitizedErrorDetail, logError } from "../utils";
import { checkWithAiSdk } from "./ai-sdk-check";
import { buildRateLimitedResult, maybeApplyRateLimitCooldown } from "./rate-limit";
import { getCheckConcurrency } from "../core/polling-config";

// 最多尝试 3 次：初始一次 + 2 次重试
const MAX_REQUEST_ABORT_RETRIES = 2;
const REQUEST_ABORTED_PATTERN = /request was aborted\.?/i;

function shouldRetryRequestAborted(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return REQUEST_ABORTED_PATTERN.test(message);
}

async function checkWithRetry(config: ProviderConfig): Promise<CheckResult> {
  for (let attempt = 0; attempt <= MAX_REQUEST_ABORT_RETRIES; attempt += 1) {
    try {
      const result = await checkWithAiSdk(config);
      if (
        result.status === "failed" &&
        shouldRetryRequestAborted(result.message) &&
        attempt < MAX_REQUEST_ABORT_RETRIES
      ) {
        console.warn(
          `[check-cx] ${config.name} 请求异常（Request was aborted），正在重试第 ${
            attempt + 2
          } 次`
        );
        continue;
      }
      return maybeApplyRateLimitCooldown(result);
    } catch (error) {
      const message = getErrorMessage(error);
      if (
        shouldRetryRequestAborted(message) &&
        attempt < MAX_REQUEST_ABORT_RETRIES
      ) {
        console.warn(
          `[check-cx] ${config.name} 请求异常（Request was aborted），正在重试第 ${
            attempt + 2
          } 次`
        );
        continue;
      }

      logError(`检查 ${config.name} (${config.type}) 失败`, error);
      return maybeApplyRateLimitCooldown({
        id: config.id,
        name: config.name,
        type: config.type,
        endpoint: config.endpoint,
        model: config.model,
        status: "error",
        latencyMs: null,
        pingLatencyMs: null,
        checkedAt: new Date().toISOString(),
        message,
        logMessage: getSanitizedErrorDetail(error),
        groupName: config.groupName || null,
      });
    }
  }

  // 理论上不会触发，这里仅为类型系统兜底
  throw new Error("Unexpected retry loop exit");
}

/**
 * 批量执行 Provider 健康检查
 * @param configs Provider 配置列表
 * @returns 检查结果列表,按名称排序
 */
export async function runProviderChecks(
  configs: ProviderConfig[],
  options?: {
    checker?: (config: ProviderConfig) => Promise<CheckResult>;
    now?: () => number;
  }
): Promise<CheckResult[]> {
  if (configs.length === 0) {
    return [];
  }

  const checker = options?.checker ?? checkWithRetry;
  const now = options?.now ?? Date.now;
  const limit = pLimit(getCheckConcurrency());
  const results = await Promise.all(
    configs.map((config) =>
      limit(async () => {
        const skipped = buildRateLimitedResult(config, now());
        if (skipped) {
          return skipped;
        }

        const result = await checker(config);
        return maybeApplyRateLimitCooldown(result, now());
      })
    )
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// 导出统一检查函数
export { checkWithAiSdk } from "./ai-sdk-check";
