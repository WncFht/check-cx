import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("production scripts use the verified local runtime paths", () => {
  assert.equal(
    packageJson.scripts.start,
    "node scripts/start-server.mjs",
    "start should use the standalone-aware launcher"
  );
  assert.equal(
    packageJson.scripts.build,
    "next build --webpack",
    "build should use webpack because the default Turbopack path is not stable in this environment"
  );
  assert.equal(
    packageJson.scripts.ctl,
    "node scripts/check-cxctl.mjs",
    "ctl should point at the local operations helper"
  );
});
