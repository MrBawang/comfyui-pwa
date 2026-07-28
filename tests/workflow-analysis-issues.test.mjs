import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workbenchSource = readFileSync(
  new URL("../web/src/components/workbench.tsx", import.meta.url),
  "utf8",
);

test("every blocking workflow issue has a visible alert", () => {
  assert.match(
    workbenchSource,
    /!analysis\.runnable && analysis\.issues\.length > 0[\s\S]*className="analysis-issues" role="alert"[\s\S]*analysis\.issues\.map/,
  );
});

test("unsupported workflow inputs show the available cloud values", () => {
  assert.match(workbenchSource, /analysis\.unsupportedInputs\?\.map/);
  assert.match(workbenchSource, /当前可用值：\{availableValuesSummary\(item\)\}/);
});
