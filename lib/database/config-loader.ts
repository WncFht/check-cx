/**
 * 数据库配置加载模块
 */

import "server-only";
import {createAdminClient} from "../supabase/admin";
import {getPollingIntervalMs} from "../core/polling-config";
import type {CheckConfigRow, ProviderConfig, ProviderType} from "../types";
import type {CheckModelRow, CheckRequestTemplateRow} from "../types/database";
import {logError} from "../utils";

interface ConfigCache {
  data: ProviderConfig[];
  lastFetchedAt: number;
}

interface ConfigCacheMetrics {
  hits: number;
  misses: number;
}

type JsonRecord = Record<string, unknown>;
type TemplateProjection = Pick<CheckRequestTemplateRow, "type" | "request_header" | "metadata">;
type ModelProjection = Pick<CheckModelRow, "id" | "type" | "model" | "template_id"> & {
  check_request_templates?: TemplateProjection | TemplateProjection[] | null;
};
type ConfigRowWithModel = Pick<
  CheckConfigRow,
  "id" | "name" | "type" | "model_id" | "endpoint" | "api_key" | "is_maintenance" | "group_name"
> & {
  check_models?: ModelProjection | ModelProjection[] | null;
};

const cache: ConfigCache = {
  data: [],
  lastFetchedAt: 0,
};

const metrics: ConfigCacheMetrics = {
  hits: 0,
  misses: 0,
};

export function getConfigCacheMetrics(): ConfigCacheMetrics {
  return { ...metrics };
}

export function resetConfigCacheMetrics(): void {
  metrics.hits = 0;
  metrics.misses = 0;
}

function normalizeJsonRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function getModel(row: ConfigRowWithModel): ModelProjection | null {
  const model = Array.isArray(row.check_models)
    ? row.check_models[0]
    : row.check_models;

  if (!model || model.type !== row.type) {
    return null;
  }

  return model;
}

function getTemplateFromModel(row: ConfigRowWithModel): TemplateProjection | null {
  const model = getModel(row);
  const template = Array.isArray(model?.check_request_templates)
    ? model.check_request_templates[0]
    : model?.check_request_templates;

  if (!template || template.type !== row.type) {
    return null;
  }

  return template;
}

/**
 * 从数据库加载启用的 Provider 配置
 * @returns Provider 配置列表
 */
export async function loadProviderConfigsFromDB(options?: {
  forceRefresh?: boolean;
}): Promise<ProviderConfig[]> {
  try {
    const now = Date.now();
    const ttl = getPollingIntervalMs();
    if (!options?.forceRefresh && now - cache.lastFetchedAt < ttl) {
      metrics.hits += 1;
      return cache.data;
    }
    metrics.misses += 1;

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("check_configs")
      .select(
        "id, name, type, model_id, endpoint, api_key, is_maintenance, group_name, check_models(id, type, model, template_id, check_request_templates(type, request_header, metadata))"
      )
      .eq("enabled", true)
      .order("id");

    if (error) {
      logError("从数据库加载配置失败", error);
      return [];
    }

    if (!data || data.length === 0) {
      console.warn("[check-cx] 数据库中没有找到启用的配置");
      cache.data = [];
      cache.lastFetchedAt = now;
      return [];
    }

    const configs: ProviderConfig[] = data.map(
      (row: ConfigRowWithModel) => {
        const model = getModel(row);
        const template = getTemplateFromModel(row);
        const mergedRequestHeaders = normalizeJsonRecord(template?.request_header) as Record<string, string> | null;
        const mergedMetadata = normalizeJsonRecord(template?.metadata);

        return {
          id: row.id,
          name: row.name,
          type: row.type as ProviderType,
          endpoint: row.endpoint,
          model: model?.model ?? "",
          apiKey: row.api_key,
          is_maintenance: row.is_maintenance,
          requestHeaders: mergedRequestHeaders,
          metadata: mergedMetadata,
          groupName: row.group_name || null,
        };
      }
    );

    cache.data = configs;
    cache.lastFetchedAt = now;
    return configs;
  } catch (error) {
    logError("加载配置时发生异常", error);
    return [];
  }
}
