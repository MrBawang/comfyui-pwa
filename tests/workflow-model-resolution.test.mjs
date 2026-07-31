import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../web/src/components/workbench.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("missing models can use an existing cloud file, Hugging Face, or a trusted URL", () => {
  assert.match(source, /云端已有/);
  assert.match(source, /Hugging Face/);
  assert.match(source, /下载链接/);
  assert.match(source, /\/api\/resources\/models/);
  assert.match(source, /sourceKind: "url"/);
  assert.match(styles, /\.model-source-tabs/);
});

test("model bindings follow analyze, save, convert, and stored recheck requests", () => {
  assert.match(source, /appendModelBindings\(form, bindings\)/);
  assert.match(source, /appendModelBindings\(form, modelBindings\)/);
  assert.match(source, /JSON\.stringify\(\{ modelBindings: bindings \}\)/);
  assert.match(source, /actualFilename/);
});
