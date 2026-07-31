import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runnerSource = readFileSync(
  new URL("../web/src/components/workflow-runner.tsx", import.meta.url),
  "utf8",
);
const globalStyles = readFileSync(
  new URL("../web/src/styles.css", import.meta.url),
  "utf8",
);

function cssRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return globalStyles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

test("workflow output uses a selectable browser with an accessible preview dialog", () => {
  assert.match(
    runnerSource,
    /className="output-browser"[\s\S]*className="output-browser__thumbnails"[\s\S]*<dialog ref=\{dialog\} className="output-preview-dialog"/,
  );
  assert.match(runnerSource, /event\.key === "ArrowLeft"/);
  assert.match(runnerSource, /event\.key === "ArrowRight"/);
  assert.doesNotMatch(globalStyles, /\.workflow-canvas\s*>\s*img\s*\{/);
});

test("output preview fits landscape and portrait images without cropping", () => {
  const containerRule = cssRule(".output-browser__main");
  const imageRule = globalStyles.match(/\.output-browser__preview img,[\s\S]*?\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(containerRule, /min-width:\s*0\s*;/);
  assert.match(containerRule, /min-height:\s*0\s*;/);
  assert.match(containerRule, /place-items:\s*center\s*;/);
  assert.match(imageRule, /width:\s*100%\s*;/);
  assert.match(imageRule, /height:\s*100%\s*;/);
  assert.match(imageRule, /object-fit:\s*contain\s*;/);
});
