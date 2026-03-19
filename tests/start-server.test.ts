import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {getStartPlan, prepareStandaloneAssets} from "../scripts/start-server.mjs";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "check-cx-start-"));
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), {recursive: true});
  writeFileSync(path, content);
}

test("prepareStandaloneAssets copies static and public assets into the standalone bundle", () => {
  const projectDir = createTempProject();

  try {
    writeFile(join(projectDir, ".next", "standalone", "server.js"), "console.log('server');\n");
    writeFile(join(projectDir, ".next", "static", "chunks", "main.js"), "console.log('main');\n");
    writeFile(join(projectDir, "public", "favicon.png"), "icon");

    const prepared = prepareStandaloneAssets(projectDir);

    assert.equal(prepared, true);
    assert.equal(
      readFileSync(
        join(projectDir, ".next", "standalone", ".next", "static", "chunks", "main.js"),
        "utf8"
      ),
      "console.log('main');\n"
    );
    assert.equal(
      readFileSync(join(projectDir, ".next", "standalone", "public", "favicon.png"), "utf8"),
      "icon"
    );
  } finally {
    rmSync(projectDir, {recursive: true, force: true});
  }
});

test("getStartPlan uses the standalone server when present", () => {
  const projectDir = createTempProject();

  try {
    writeFile(join(projectDir, ".next", "standalone", "server.js"), "console.log('server');\n");

    const plan = getStartPlan({projectDir, env: {}});

    assert.equal(plan.mode, "standalone");
    assert.equal(plan.command, process.execPath);
    assert.equal(plan.cwd, join(projectDir, ".next", "standalone"));
    assert.deepEqual(plan.args, ["server.js"]);
  } finally {
    rmSync(projectDir, {recursive: true, force: true});
  }
});

test("getStartPlan falls back to next start when standalone output is disabled", () => {
  const projectDir = createTempProject();

  try {
    const plan = getStartPlan({projectDir, env: {NEXT_DISABLE_STANDALONE: "1"}});

    assert.equal(plan.mode, "next-start");
    assert.equal(plan.command, process.execPath);
    assert.equal(plan.cwd, projectDir);
    assert.match(plan.args[0], /next[\\/]dist[\\/]bin[\\/]next$/);
    assert.deepEqual(plan.args.slice(1), ["start"]);
  } finally {
    rmSync(projectDir, {recursive: true, force: true});
  }
});
