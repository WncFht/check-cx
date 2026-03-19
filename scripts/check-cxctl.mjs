#!/usr/bin/env node

import {openSync, readFileSync, writeFileSync, existsSync, unlinkSync} from "node:fs";
import {resolve} from "node:path";
import {spawn, spawnSync} from "node:child_process";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {createClient} from "@supabase/supabase-js";
import {getStartPlan} from "./start-server.mjs";

const DEFAULT_GROUP = "cch";
const DEFAULT_PORT = 24167;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PID_FILE = "/tmp/check-cx.pid";
const DEFAULT_LOG_FILE = "/tmp/check-cx.log";
const DEFAULT_CCH_API_URL = "http://127.0.0.1:23000";
const DEFAULT_CCH_ENV_PATH = "/Users/fanghaotian/Applications/claude-code-hub/.env";
const PROXY_HELPER = "/Users/fanghaotian/.config/shell/proxy.sh";
const MODEL_PREFERENCES = {
  codex: ["gpt-5.4", "gpt-5", "gpt-5.3-codex", "gpt-5.2-codex"],
  "openai-compatible": ["gpt-5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2"],
};

export function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return index < 0 ? null : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      })
      .filter(Boolean)
  );
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
      continue;
    }

    flags[key] = true;
  }

  return {positional, flags};
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return /^(1|true|yes|on)$/i.test(String(value));
}

function ensureOption(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === "") {
    throw new Error(`缺少参数 --${name}`);
  }
  return String(value);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(stderr || stdout || `${command} ${args.join(" ")} 失败`);
  }

  return result.stdout?.trim() ?? "";
}

function runProxyShell(command, {cwd = process.cwd()} = {}) {
  return runCommand(
    "zsh",
    ["-lc", `source '${PROXY_HELPER}'; proxy_on >/dev/null; ${command}`],
    {cwd, capture: false}
  );
}

function getRuntimeOptions(projectDir, flags) {
  const env = readEnvFile(resolve(projectDir, ".env.local"));
  return {
    env,
    host: String(flags.host || process.env.HOSTNAME || DEFAULT_HOST),
    port: Number(flags.port || process.env.PORT || DEFAULT_PORT),
    pidFile: String(flags["pid-file"] || DEFAULT_PID_FILE),
    logFile: String(flags["log-file"] || DEFAULT_LOG_FILE),
    groupName: String(flags.group || DEFAULT_GROUP),
  };
}

function readPid(pidFile) {
  if (!existsSync(pidFile)) {
    return null;
  }

  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function syncPidFile(pidFile, pid) {
  if (pid) {
    writeFileSync(pidFile, `${pid}\n`);
    return;
  }

  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

function isProcessRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findListeningPid(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return null;
  }

  const pid = Number(result.stdout.trim().split(/\r?\n/)[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function resolveServicePid({pidFromFile, isPidRunning, listenerPid}) {
  if (pidFromFile && isPidRunning) {
    return {pid: pidFromFile, source: "pid-file"};
  }

  if (listenerPid) {
    return {pid: listenerPid, source: "listener"};
  }

  return {pid: null, source: null};
}

function getServiceProcess(runtime) {
  const pidFromFile = readPid(runtime.pidFile);
  const listenerPid = findListeningPid(runtime.port);
  const resolved = resolveServicePid({
    pidFromFile,
    isPidRunning: isProcessRunning(pidFromFile),
    listenerPid,
  });

  if (resolved.pid !== pidFromFile) {
    syncPidFile(runtime.pidFile, resolved.pid);
  }

  return resolved;
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function waitForServiceReady(runtime, startedPid) {
  const deadline = Date.now() + 10_000;
  const baseUrl = `http://${runtime.host}:${runtime.port}`;
  let lastError = null;

  while (Date.now() < deadline) {
    const current = getServiceProcess(runtime);
    if (current.pid && current.pid !== startedPid) {
      return current.pid;
    }

    if (!isProcessRunning(startedPid)) {
      break;
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return current.pid || startedPid;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  const current = getServiceProcess(runtime);
  if (current.pid) {
    return current.pid;
  }

  const message = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`服务启动失败，请查看日志 ${runtime.logFile}${message}`);
}

async function waitForServiceStop(runtime, pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = getServiceProcess(runtime);
    if (current.pid !== pid) {
      return;
    }
    await delay(200);
  }

  process.kill(pid, "SIGKILL");

  const forceDeadline = Date.now() + 2_000;
  while (Date.now() < forceDeadline) {
    const current = getServiceProcess(runtime);
    if (current.pid !== pid) {
      return;
    }
    await delay(100);
  }

  throw new Error(`服务停止失败，PID ${pid} 仍在监听 ${runtime.port}`);
}

export function getServiceStartPlan(projectDir, flags, parentEnv = process.env) {
  const runtime = getRuntimeOptions(projectDir, flags);
  const env = {
    ...parentEnv,
    ...runtime.env,
    PORT: String(runtime.port),
    HOSTNAME: runtime.host,
  };
  const plan = getStartPlan({projectDir, env});

  return {
    ...runtime,
    ...plan,
    env,
  };
}

async function fetchPageSummary(baseUrl, groupName) {
  const home = await fetch(baseUrl);
  const homeHtml = await home.text();
  const group = await fetch(`${baseUrl}/group/${encodeURIComponent(groupName)}`);
  const groupHtml = await group.text();
  const cssAsset = groupHtml.match(/href="([^"]*\/_next\/static\/css\/[^"]+\.css)"/)?.[1] || null;
  const cssStatus = cssAsset ? (await fetch(`${baseUrl}${cssAsset}`)).status : null;
  const groupApi = await fetch(`${baseUrl}/api/group/${encodeURIComponent(groupName)}?trendPeriod=7d`);
  const groupData = groupApi.ok ? await groupApi.json() : null;

  return {
    home: {
      status: home.status,
      title: homeHtml.match(/<title>(.*?)<\/title>/i)?.[1] ?? null,
    },
    group: {
      status: group.status,
      title: groupHtml.match(/<title>(.*?)<\/title>/i)?.[1] ?? null,
      apiStatus: groupApi.status,
      total: groupData?.total ?? null,
      statuses: groupData?.providerTimelines?.map((item) => ({
        name: item.latest.name,
        status: item.latest.status,
      })) ?? [],
    },
    assets: {
      cssAsset,
      cssStatus,
    },
  };
}

function createSupabaseAdmin(projectDir) {
  const env = {...readEnvFile(resolve(projectDir, ".env.local")), ...process.env};
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false},
  });
}

export function normalizeProviderUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function pickCheckModel(models, providerType) {
  const normalized = [...new Set((Array.isArray(models) ? models : []).map((item) => String(item || "").trim()).filter(Boolean))];
  const preferred = MODEL_PREFERENCES[providerType] || ["gpt-5.4", "gpt-5"];
  for (const candidate of preferred) {
    if (normalized.includes(candidate)) {
      return candidate;
    }
  }
  return normalized[0] || "gpt-5.4";
}

export function mapCchProviderToCheckConfig(provider, {groupName = DEFAULT_GROUP} = {}) {
  const baseUrl = normalizeProviderUrl(provider.url);
  const endpoint =
    provider.providerType === "openai-compatible"
      ? `${baseUrl}/chat/completions`
      : `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/responses`;

  return {
    name: String(provider.name).trim(),
    type: "openai",
    model: pickCheckModel(provider.allowedModels, provider.providerType),
    endpoint,
    api_key: String(provider.key).trim(),
    enabled: true,
    is_maintenance: false,
    group_name: groupName,
    request_header: null,
    metadata: null,
    template_id: null,
  };
}

async function postJson(url, token, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`请求失败: ${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

function getCchDbContainerName() {
  const output = runCommand("docker", ["ps", "--format", "{{.Names}}"]);
  const matched = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((name) => name.startsWith("claude-code-hub-db"));

  if (!matched) {
    throw new Error("未找到 claude-code-hub 的数据库容器");
  }

  return matched;
}

async function loadEnabledCchProviders(flags) {
  const cchEnvPath = String(flags["cch-env"] || DEFAULT_CCH_ENV_PATH);
  const cchEnv = readEnvFile(cchEnvPath);
  const adminToken = cchEnv.ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error(`未在 ${cchEnvPath} 中找到 ADMIN_TOKEN`);
  }

  const apiUrl = String(flags["cch-api-url"] || process.env.CCH_API_URL || DEFAULT_CCH_API_URL);
  const payload = await postJson(`${apiUrl}/api/actions/providers/getProviders`, adminToken, {});
  const enabledProviders = (Array.isArray(payload?.data) ? payload.data : []).filter((provider) => provider?.isEnabled);

  const dbContainer = getCchDbContainerName();
  const dbUser = cchEnv.DB_USER || "postgres";
  const dbPassword = cchEnv.DB_PASSWORD || "";
  const dbName = cchEnv.DB_NAME || "claude_code_hub";
  const keyRows = runCommand("docker", [
    "exec",
    "-e",
    `PGPASSWORD=${dbPassword}`,
    "-i",
    dbContainer,
    "psql",
    "-U",
    dbUser,
    "-d",
    dbName,
    "-At",
    "-F",
    "\t",
    "-c",
    'select id, name, provider_type, url, key from providers where is_enabled = true order by id;',
  ]);

  const keyMap = new Map(
    keyRows
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [id, name, providerType, url, key] = line.split("\t");
        return [Number(id), {name, providerType, url, key}];
      })
  );

  return enabledProviders
    .map((provider) => {
      const details = keyMap.get(Number(provider.id));
      if (!details?.key) {
        return null;
      }

      return {
        id: Number(provider.id),
        name: provider.name,
        providerType: provider.providerType,
        url: provider.url,
        allowedModels: Array.isArray(provider.allowedModels) ? provider.allowedModels : [],
        key: details.key,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function upsertProviderConfig(supabase, config, {patchOnly = false} = {}) {
  const {data: existing, error: selectError} = await supabase
    .from("check_configs")
    .select("id, name")
    .eq("name", config.name)
    .eq("group_name", config.group_name || null)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  if (!existing) {
    const {data, error} = await supabase
      .from("check_configs")
      .insert(config)
      .select("id, name")
      .single();
    if (error) {
      throw error;
    }
    return {action: "inserted", id: data.id, name: data.name};
  }

  const updatePayload = patchOnly ? config : {...config};
  const {error} = await supabase.from("check_configs").update(updatePayload).eq("id", existing.id);
  if (error) {
    throw error;
  }
  return {action: "updated", id: existing.id, name: existing.name};
}

async function commandService(action, flags, projectDir) {
  const runtime = getRuntimeOptions(projectDir, flags);
  const baseUrl = `http://${runtime.host}:${runtime.port}`;
  const current = getServiceProcess(runtime);

  if (action === "start") {
    if (current.pid) {
      console.log(
        JSON.stringify(
          {status: "already_running", pid: current.pid, pidSource: current.source, baseUrl},
          null,
          2
        )
      );
      return;
    }

    const plan = getServiceStartPlan(projectDir, flags);
    const outFd = openSync(runtime.logFile, "a");
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: true,
      stdio: ["ignore", outFd, outFd],
    });
    child.unref();
    syncPidFile(runtime.pidFile, child.pid);
    const pid = await waitForServiceReady(runtime, child.pid);
    console.log(JSON.stringify({status: "started", pid, baseUrl, logFile: runtime.logFile}, null, 2));
    return;
  }

  if (action === "stop") {
    if (!current.pid) {
      console.log(JSON.stringify({status: "not_running", pid: null}, null, 2));
      return;
    }

    process.kill(current.pid, "SIGTERM");
    await waitForServiceStop(runtime, current.pid);
    syncPidFile(runtime.pidFile, null);
    console.log(JSON.stringify({status: "stopped", pid: current.pid}, null, 2));
    return;
  }

  if (action === "restart") {
    await commandService("stop", flags, projectDir);
    await commandService("start", flags, projectDir);
    return;
  }

  if (action === "status") {
    const summary = {
      pid: current.pid,
      pidSource: current.source,
      running: Boolean(current.pid),
      baseUrl,
      pidFile: runtime.pidFile,
      logFile: runtime.logFile,
      pages: null,
    };

    if (summary.running) {
      try {
        summary.pages = await fetchPageSummary(baseUrl, runtime.groupName);
      } catch (error) {
        summary.pages = {error: error instanceof Error ? error.message : String(error)};
      }
    }

    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (action === "logs") {
    const tail = Number(flags.tail || 80);
    runCommand("tail", ["-n", String(tail), runtime.logFile], {capture: false});
    return;
  }

  throw new Error(`未知 service 子命令: ${action}`);
}

async function commandProviders(action, flags, projectDir) {
  const supabase = createSupabaseAdmin(projectDir);
  const groupName = String(flags.group || DEFAULT_GROUP);

  if (action === "list") {
    const {data, error} = await supabase
      .from("check_configs")
      .select("name,type,model,endpoint,enabled,is_maintenance,group_name,updated_at")
      .eq("group_name", groupName)
      .order("name");
    if (error) {
      throw error;
    }
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (action === "sync-cch") {
    const providers = await loadEnabledCchProviders(flags);
    const mapped = providers.map((provider) => mapCchProviderToCheckConfig(provider, {groupName}));
    const results = [];
    for (const config of mapped) {
      results.push(await upsertProviderConfig(supabase, config));
    }
    console.log(JSON.stringify({groupName, providers: mapped.map((item) => item.name), results}, null, 2));
    return;
  }

  if (action === "upsert") {
    const config = {
      name: ensureOption(flags, "name"),
      type: String(flags.type || "openai"),
      model: ensureOption(flags, "model"),
      endpoint: ensureOption(flags, "endpoint"),
      api_key: ensureOption(flags, "api-key"),
      enabled: parseBoolean(flags.enabled, true),
      is_maintenance: parseBoolean(flags.maintenance, false),
      group_name: groupName,
      request_header: null,
      metadata: null,
      template_id: null,
    };
    const result = await upsertProviderConfig(supabase, config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === "set") {
    const name = ensureOption(flags, "name");
    const patch = {};
    if (flags.type !== undefined) patch.type = String(flags.type);
    if (flags.model !== undefined) patch.model = String(flags.model);
    if (flags.endpoint !== undefined) patch.endpoint = String(flags.endpoint);
    if (flags["api-key"] !== undefined) patch.api_key = String(flags["api-key"]);
    if (flags.enabled !== undefined) patch.enabled = parseBoolean(flags.enabled, true);
    if (flags.maintenance !== undefined) patch.is_maintenance = parseBoolean(flags.maintenance, false);
    if (flags.group !== undefined) patch.group_name = groupName;

    const {data: existing, error: selectError} = await supabase
      .from("check_configs")
      .select("id,name")
      .eq("name", name)
      .eq("group_name", groupName)
      .maybeSingle();
    if (selectError) throw selectError;
    if (!existing) {
      throw new Error(`未找到 provider: ${name} (${groupName})`);
    }
    const {error} = await supabase.from("check_configs").update(patch).eq("id", existing.id);
    if (error) throw error;
    console.log(JSON.stringify({action: "updated", id: existing.id, name: existing.name, patch}, null, 2));
    return;
  }

  if (action === "enable" || action === "disable") {
    const name = ensureOption(flags, "name");
    const enabled = action === "enable";
    const {error} = await supabase
      .from("check_configs")
      .update({enabled})
      .eq("name", name)
      .eq("group_name", groupName);
    if (error) throw error;
    console.log(JSON.stringify({action, name, groupName}, null, 2));
    return;
  }

  if (action === "refresh") {
    const runtime = getRuntimeOptions(projectDir, flags);
    const response = await fetch(
      `http://${runtime.host}:${runtime.port}/api/group/${encodeURIComponent(groupName)}?trendPeriod=7d&forceRefresh=1`
    );
    const payload = await response.json();
    console.log(
      JSON.stringify(
        {
          status: response.status,
          total: payload.total,
          statuses: payload.providerTimelines.map((item) => ({
            name: item.latest.name,
            status: item.latest.status,
            message: item.latest.message,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  throw new Error(`未知 providers 子命令: ${action}`);
}

async function commandBuild(projectDir) {
  runProxyShell("pnpm build", {cwd: projectDir});
}

async function commandUpdate(flags, projectDir) {
  const dirty = runCommand("git", ["status", "--porcelain"], {cwd: projectDir});
  if (dirty) {
    throw new Error("工作区不干净，拒绝自动 update。请先提交或暂存本地改动。");
  }

  runProxyShell("git pull --ff-only", {cwd: projectDir});
  runProxyShell("pnpm install --frozen-lockfile", {cwd: projectDir});
  await commandBuild(projectDir);
  await commandService("restart", flags, projectDir);
}

function printHelp() {
  console.log(`Usage:
  node scripts/check-cxctl.mjs service <start|stop|restart|status|logs> [--port 24167] [--host 127.0.0.1]
  node scripts/check-cxctl.mjs build
  node scripts/check-cxctl.mjs update
  node scripts/check-cxctl.mjs providers <list|sync-cch|upsert|set|enable|disable|refresh> [--group cch]
`);
}

async function main() {
  const projectDir = process.cwd();
  const {positional, flags} = parseArgs(process.argv.slice(2));
  const [area, action] = positional;

  if (!area) {
    printHelp();
    return;
  }

  if (area === "service") {
    await commandService(action || "status", flags, projectDir);
    return;
  }

  if (area === "providers") {
    if (!action) {
      throw new Error("缺少 providers 子命令");
    }
    await commandProviders(action, flags, projectDir);
    return;
  }

  if (area === "build") {
    await commandBuild(projectDir);
    return;
  }

  if (area === "update") {
    await commandUpdate(flags, projectDir);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
