import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cameraParameterValues,
  characterBatchStatus,
  characterProjectActive,
  characterWorkflowCompatible,
  defaultCharacterViewIds,
  nextCharacterGenerationProjectId,
  selectedViewPresets,
} from "../web/src/lib/character-project.ts";
const characterProjectsSource = readFileSync(
  new URL("../web/src/components/character-projects.tsx", import.meta.url),
  "utf8",
);
const coreRoutesSource = readFileSync(
  new URL("../worker/src/core-routes.ts", import.meta.url),
  "utf8",
);
const queueSource = readFileSync(new URL("../worker/src/gpu-queue.ts", import.meta.url), "utf8");
const globalStyles = readFileSync(
  new URL("../web/src/styles.css", import.meta.url),
  "utf8",
);

function workflow(overrides = {}) {
  return {
    id: "workflow",
    revisionId: "revision",
    name: "多视角",
    status: "ready",
    imageInputs: [{ fieldName: "asset_41_image" }],
    parameterInputs: [
      { fieldName: "control_217_horizontal_angle", inputName: "horizontal_angle", currentValue: 0 },
      { fieldName: "control_217_vertical_angle", inputName: "vertical_angle", currentValue: 0 },
      { fieldName: "control_217_zoom", inputName: "zoom", currentValue: 4 },
    ],
    ...overrides,
  };
}

test("default character plan favors the four useful side views", () => {
  assert.deepEqual(defaultCharacterViewIds(), ["right-front", "right-side", "left-side", "left-front"]);
  assert.deepEqual(
    selectedViewPresets(["left-side", "right-side"]).map((item) => item.id),
    ["right-side", "left-side"],
  );
});

test("only ready single-image workflows with all camera controls are compatible", () => {
  assert.equal(characterWorkflowCompatible(workflow()), true);
  assert.equal(characterWorkflowCompatible(workflow({ status: "stale" })), false);
  assert.equal(characterWorkflowCompatible(workflow({ imageInputs: [{}, {}] })), false);
  assert.equal(characterWorkflowCompatible(workflow({ parameterInputs: [] })), false);
});

test("camera values override the selected view without changing field names", () => {
  assert.deepEqual(
    cameraParameterValues(workflow(), { horizontalAngle: 270, verticalAngle: 60, zoom: 8 }),
    {
      control_217_horizontal_angle: "270",
      control_217_vertical_angle: "60",
      control_217_zoom: "8",
    },
  );
});

test("batch status distinguishes generation, analysis and partial completion", () => {
  const batch = {
    views: [
      { status: "succeeded" },
      { status: "processing" },
    ],
    analysis: { status: "idle" },
  };
  assert.equal(characterBatchStatus(batch), "generating");
  batch.views[1].status = "succeeded";
  assert.equal(characterBatchStatus(batch), "analyzing");
  batch.analysis.status = "succeeded";
  assert.equal(characterBatchStatus(batch), "succeeded");
  batch.views[1].status = "failed";
  assert.equal(characterBatchStatus(batch), "partial");
});

test("global generation queue keeps one processing project and otherwise uses FIFO", () => {
  const makeProject = (id, createdAt, viewStatus, batchStatus = "queued") => ({
    id,
    batches: [{
      id: `${id}-batch`,
      status: batchStatus,
      createdAt,
      views: [{ status: viewStatus }],
      analysis: { status: "idle" },
    }],
  });
  const queuedLater = makeProject("later", 20, "queued");
  const queuedFirst = makeProject("first", 10, "queued");
  const processing = makeProject("processing", 30, "processing", "generating");

  assert.equal(nextCharacterGenerationProjectId([queuedLater, queuedFirst]), "first");
  assert.equal(nextCharacterGenerationProjectId([queuedFirst, processing]), "processing");
  assert.equal(characterProjectActive(processing), true);
  assert.equal(characterProjectActive(makeProject("done", 1, "succeeded", "succeeded")), false);
});

test("character generation shares the global serial Durable Object queue", () => {
  assert.match(coreRoutesSource, /VALUES \(\?1, \?2, 'character', 'queued'/);
  assert.match(coreRoutesSource, /await wakeQueue\(c\.env\)/);
  assert.match(queueSource, /idFromName\("global"\)/);
  assert.match(queueSource, /max_inputs|nextRun|ORDER BY/);
});

test("LoRAChef rescreening is protected from duplicate submissions", () => {
  assert.match(characterProjectsSource, /if \(!selected \|\| retryingBatchId\) return/);
  assert.match(characterProjectsSource, /disabled=\{Boolean\(retryingBatchId\)\}/);
  assert.match(
    coreRoutesSource,
    /ON CONFLICT\(batch_id\) DO UPDATE SET status = 'waiting'/,
  );
});

test("late batch responses cannot replace a newly selected character project", () => {
  assert.match(characterProjectsSource, /selectedIdRef\.current = projectId/);
  assert.match(
    characterProjectsSource,
    /if \(selectedIdRef\.current === body\.id\) setSelected\(body\)/,
  );
});

test("a single candidate stays compact without cropping its image", () => {
  assert.match(
    globalStyles,
    /\.character-candidate-grid \{[^}]*minmax\(220px, 300px\)/,
  );
  assert.match(globalStyles, /\.character-candidate img \{[^}]*object-fit: contain/);
});
