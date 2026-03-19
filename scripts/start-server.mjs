#!/usr/bin/env node

import {spawn} from "node:child_process";
import {cpSync, existsSync, mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);

export function prepareStandaloneAssets(projectDir) {
  const standaloneDir = resolve(projectDir, ".next", "standalone");
  const standaloneServer = resolve(standaloneDir, "server.js");
  if (!existsSync(standaloneServer)) {
    return false;
  }

  const standaloneNextDir = resolve(standaloneDir, ".next");
  const staticSource = resolve(projectDir, ".next", "static");
  const staticDest = resolve(standaloneNextDir, "static");
  const publicSource = resolve(projectDir, "public");
  const publicDest = resolve(standaloneDir, "public");

  mkdirSync(standaloneNextDir, {recursive: true});

  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDest, {recursive: true, force: true});
  }

  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDest, {recursive: true, force: true});
  }

  return true;
}

export function getStartPlan({
  projectDir = process.cwd(),
  env = process.env,
} = {}) {
  const standaloneDir = resolve(projectDir, ".next", "standalone");
  const standaloneServer = resolve(standaloneDir, "server.js");

  if (env.NEXT_DISABLE_STANDALONE !== "1" && existsSync(standaloneServer)) {
    prepareStandaloneAssets(projectDir);
    return {
      mode: "standalone",
      command: process.execPath,
      args: ["server.js"],
      cwd: standaloneDir,
    };
  }

  return {
    mode: "next-start",
    command: process.execPath,
    args: [require.resolve("next/dist/bin/next"), "start"],
    cwd: projectDir,
  };
}

function run() {
  const plan = getStartPlan();
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error("[check-cx] 启动失败", error);
    process.exit(1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}
