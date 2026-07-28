import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestRequestGuard,
  isTerminalJobStatus,
  parseActiveRunJob,
  reconcileWorkflowImageFiles,
  serializeActiveRunJob,
} from "../web/src/lib/workflow-state.ts";

test("only the latest analysis request remains current", async () => {
  const guard = createLatestRequestGuard();
  const accepted = [];
  let resolveFirst;
  let resolveSecond;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  const secondResponse = new Promise((resolve) => { resolveSecond = resolve; });

  async function analyze(response) {
    const requestId = guard.begin();
    const value = await response;
    if (guard.isCurrent(requestId)) accepted.push(value);
  }

  const firstRun = analyze(firstResponse);
  const secondRun = analyze(secondResponse);
  resolveSecond("new workflow");
  await secondRun;
  resolveFirst("old workflow");
  await firstRun;

  assert.deepEqual(accepted, ["new workflow"]);
});

test("workflow image files retain only fields in the latest analysis", () => {
  const source = { asset_1_image: "source", asset_2_mask: "mask" };

  assert.deepEqual(
    reconcileWorkflowImageFiles(source, ["asset_1_image"]),
    { asset_1_image: "source" },
  );
  assert.strictEqual(
    reconcileWorkflowImageFiles(source, ["asset_1_image", "asset_2_mask"]),
    source,
  );
});

test("only completed run states are terminal", () => {
  assert.equal(isTerminalJobStatus("succeeded"), true);
  assert.equal(isTerminalJobStatus("failed"), true);
  assert.equal(isTerminalJobStatus("cancelled"), true);
  assert.equal(isTerminalJobStatus("processing"), false);
  assert.equal(isTerminalJobStatus("uploading"), false);
});

test("active run state preserves prompt and variant across refresh", () => {
  const serialized = serializeActiveRunJob({
    jobId: "fc-job",
    workflowId: "workflow-id",
    variantId: "optional-image-11",
    textValues: { param_21_text: "自定义提示词" },
    parameterValues: { control_217_horizontal_angle: "315" },
  });

  assert.deepEqual(parseActiveRunJob(serialized), {
    jobId: "fc-job",
    workflowId: "workflow-id",
    variantId: "optional-image-11",
    textValues: { param_21_text: "自定义提示词" },
    parameterValues: { control_217_horizontal_angle: "315" },
  });
  assert.deepEqual(parseActiveRunJob("legacy-job-id"), {
    jobId: "legacy-job-id",
    textValues: {},
    parameterValues: {},
  });
  assert.equal(parseActiveRunJob("{broken"), undefined);
});
