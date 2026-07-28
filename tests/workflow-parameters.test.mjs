import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runnerSource = readFileSync(
  new URL("../web/src/components/workflow-runner.tsx", import.meta.url),
  "utf8",
);
const workbenchSource = readFileSync(
  new URL("../web/src/components/workbench.tsx", import.meta.url),
  "utf8",
);

test("saved workflow parameters are rendered and submitted from the run page", () => {
  assert.match(runnerSource, /cameraParameterInputs[\s\S]*<CameraParameters/);
  assert.match(runnerSource, /HORIZONTAL_PRESETS[\s\S]*正面[\s\S]*左侧/);
  assert.match(runnerSource, /fallbackParameterInputs\.map/);
  assert.match(runnerSource, /genericParameterInputs\.map/);
  assert.match(runnerSource, /HIDDEN_CAMERA_CONTROL_NAMES[\s\S]*fallbackParameterInputs/);
  assert.match(runnerSource, /fields: \{ \.\.\.submittedTextValues, \.\.\.submittedParameterValues \}/);
  assert.match(runnerSource, /parameterValues: submittedParameterValues/);
});

test("compatibility changes are disclosed without duplicating failed job errors", () => {
  assert.match(workbenchSource, /已应用云端兼容调整/);
  assert.match(runnerSource, /云端兼容模式/);
  assert.doesNotMatch(runnerSource, /job\?\.status === "failed" && <p className="form-error"/);
});

test("workflow inspection reports the number and defaults of exposed parameters", () => {
  assert.match(workbenchSource, /parameterInputs\.length\} 参数/);
  assert.match(workbenchSource, /parameterInputs\.map[\s\S]*默认 \{String\(item\.currentValue\)\}/);
});
