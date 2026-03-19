import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRoot), "utf8");
}

test("server startup wires the poller through instrumentation", () => {
  const instrumentationUrl = new URL("instrumentation.ts", repoRoot);

  assert.ok(
    existsSync(instrumentationUrl),
    "expected instrumentation.ts to exist so the poller can start with the server"
  );

  const instrumentation = readText("instrumentation.ts");
  assert.match(
    instrumentation,
    /export\s+async\s+function\s+register/,
    "expected instrumentation.ts to export register()"
  );
  assert.match(
    instrumentation,
    /import\(["']\.\/lib\/core\/poller["']\)/,
    "expected register() to load the poller module"
  );

  const layout = readText("app/layout.tsx");
  assert.doesNotMatch(
    layout,
    /lib\/core\/poller/,
    "layout.tsx should not be responsible for starting the poller"
  );
});
