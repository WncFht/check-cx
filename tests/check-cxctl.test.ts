import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
  applyActiveRuntime,
  applyBindingRuntime,
  getServiceStartPlan,
  normalizeProviderConfigRow,
  mapCchProviderToCheckConfig,
  pickCheckModel,
  resolveProviderModelSelection,
  resolveServicePid,
} from "../scripts/check-cxctl.mjs";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "check-cx-ctl-"));
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), {recursive: true});
  writeFileSync(path, content);
}

test("pickCheckModel prefers chat and responses models based on provider type", () => {
  assert.equal(
    pickCheckModel(["gpt-5.4", "gpt-5"], "codex"),
    "gpt-5.4"
  );
  assert.equal(
    pickCheckModel(["gpt-5.4", "gpt-5"], "openai-compatible"),
    "gpt-5"
  );
  assert.equal(
    pickCheckModel([], "codex"),
    "gpt-5.4"
  );
});

test("mapCchProviderToCheckConfig normalizes codex providers to responses endpoints", () => {
  const mapped = mapCchProviderToCheckConfig(
    {
      name: "RC",
      providerType: "codex",
      url: "https://right.codes/codex/",
      allowedModels: ["gpt-5.4", "gpt-5"],
      key: "sk-test",
    },
    {groupName: "cch"}
  );

  assert.deepEqual(
    {
      name: mapped.name,
      type: mapped.type,
      model: mapped.model,
      endpoint: mapped.endpoint,
      group_name: mapped.group_name,
      enabled: mapped.enabled,
    },
    {
      name: "RC",
      type: "openai",
      model: "gpt-5.4",
      endpoint: "https://right.codes/codex/v1/responses",
      group_name: "cch",
      enabled: true,
    }
  );
});

test("mapCchProviderToCheckConfig keeps v1 base urls stable for chat providers", () => {
  const mapped = mapCchProviderToCheckConfig(
    {
      name: "Hiyo-1-chat",
      providerType: "openai-compatible",
      url: "https://codex.hiyo.top/v1",
      allowedModels: ["gpt-5.4", "gpt-5"],
      key: "sk-test",
    },
    {groupName: "cch"}
  );

  assert.equal(mapped.model, "gpt-5");
  assert.equal(mapped.endpoint, "https://codex.hiyo.top/v1/chat/completions");
});

test("mapCchProviderToCheckConfig appends v1 for chat providers when the base url omits it", () => {
  const mapped = mapCchProviderToCheckConfig(
    {
      name: "RC-chat",
      providerType: "openai-compatible",
      url: "https://right.codes/codex/",
      allowedModels: ["gpt-5", "gpt-5.4"],
      key: "sk-test",
    },
    {groupName: "cch"}
  );

  assert.equal(mapped.model, "gpt-5");
  assert.equal(mapped.endpoint, "https://right.codes/codex/v1/chat/completions");
});

test("normalizeProviderConfigRow flattens check_models joins into the CLI payload", () => {
  assert.deepEqual(
    normalizeProviderConfigRow({
      name: "RC",
      type: "openai",
      endpoint: "https://right.codes/codex/v1/responses",
      enabled: true,
      is_maintenance: false,
      group_name: "cch",
      updated_at: "2026-03-23T08:00:00.000Z",
      check_models: [{model: "gpt-5.4"}],
    }),
    {
      name: "RC",
      type: "openai",
      model: "gpt-5.4",
      endpoint: "https://right.codes/codex/v1/responses",
      enabled: true,
      is_maintenance: false,
      group_name: "cch",
      updated_at: "2026-03-23T08:00:00.000Z",
    }
  );
});

test("resolveProviderModelSelection keeps existing values unless flags override them", () => {
  assert.deepEqual(
    resolveProviderModelSelection(
      {
        type: "openai",
        model: "gpt-5.4",
      },
      {}
    ),
    {
      type: "openai",
      model: "gpt-5.4",
    }
  );

  assert.deepEqual(
    resolveProviderModelSelection(
      {
        type: "openai",
        model: "gpt-5.4",
      },
      {model: "gpt-5"}
    ),
    {
      type: "openai",
      model: "gpt-5",
    }
  );

  assert.deepEqual(
    resolveProviderModelSelection(
      {
        type: "openai",
        model: "gpt-5.4",
      },
      {type: "anthropic"}
    ),
    {
      type: "anthropic",
      model: "gpt-5.4",
    }
  );
});

test("getServiceStartPlan launches the standalone server directly instead of wrapping pnpm", () => {
  const projectDir = createTempProject();

  try {
    writeFile(join(projectDir, ".next", "standalone", "server.js"), "console.log('server');\n");

    const plan = getServiceStartPlan(projectDir, {}, {});

    assert.equal(plan.command, process.execPath);
    assert.equal(plan.cwd, join(projectDir, ".next", "standalone"));
    assert.deepEqual(plan.args, ["server.js"]);
    assert.equal(plan.env.PORT, "24167");
    assert.equal(plan.env.HOSTNAME, "0.0.0.0");
  } finally {
    rmSync(projectDir, {recursive: true, force: true});
  }
});

test("resolveServicePid falls back to the listener pid when the pid file is stale", () => {
  assert.deepEqual(
    resolveServicePid({
      pidFromFile: 31748,
      isPidRunning: false,
      listenerPid: 21093,
    }),
    {
      pid: 21093,
      source: "listener",
    }
  );
});

test("applyActiveRuntime prefers the current listener host and port when flags are omitted", () => {
  assert.deepEqual(
    applyActiveRuntime(
      {host: "127.0.0.1", port: 24167},
      {pid: 4011, listenHost: "100.105.212.52", listenPort: 25111},
      {}
    ),
    {host: "100.105.212.52", port: 25111}
  );
});

test("applyActiveRuntime probes localhost when the active listener is wildcard-bound", () => {
  assert.deepEqual(
    applyActiveRuntime(
      {host: "0.0.0.0", port: 24167},
      {pid: 14057, listenHost: "*", listenPort: 24167},
      {}
    ),
    {host: "127.0.0.1", port: 24167}
  );
});

test("applyBindingRuntime keeps wildcard-bound listeners on wildcard host for restart", () => {
  assert.deepEqual(
    applyBindingRuntime(
      {host: "0.0.0.0", port: 24167},
      {pid: 14057, listenHost: "*", listenPort: 24167},
      {}
    ),
    {host: "0.0.0.0", port: 24167}
  );
});
