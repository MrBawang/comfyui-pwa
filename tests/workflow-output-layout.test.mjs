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

test("single image output uses its dedicated preview container", () => {
  assert.match(
    runnerSource,
    /outputs\.length === 1[\s\S]*className="output-single"[\s\S]*<img src=\{outputs\[0\]\.url\}/,
  );
  assert.doesNotMatch(globalStyles, /\.workflow-canvas\s*>\s*img\s*\{/);
});

test("single image preview fits landscape and portrait images without cropping", () => {
  const containerRule = cssRule(".output-single");
  const imageRule = cssRule(".output-single img");

  assert.match(containerRule, /min-width:\s*0\s*;/);
  assert.match(containerRule, /min-height:\s*0\s*;/);
  assert.match(containerRule, /place-items:\s*center\s*;/);
  assert.match(imageRule, /width:\s*auto\s*;/);
  assert.match(imageRule, /height:\s*auto\s*;/);
  assert.match(imageRule, /max-width:\s*100%\s*;/);
  assert.match(imageRule, /max-height:\s*100%\s*;/);
  assert.match(imageRule, /object-fit:\s*contain\s*;/);
  assert.match(imageRule, /object-position:\s*center\s*;/);
});
