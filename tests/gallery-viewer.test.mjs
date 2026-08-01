import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gallerySource = readFileSync(
  new URL("../web/src/components/gallery-page.tsx", import.meta.url),
  "utf8",
);
const globalStyles = readFileSync(
  new URL("../web/src/styles.css", import.meta.url),
  "utf8",
);

test("gallery media opens an accessible image and video viewer", () => {
  assert.match(gallerySource, /className="gallery-media-button"/);
  assert.match(gallerySource, /<dialog ref=\{previewDialog\} className="output-preview-dialog gallery-viewer"/);
  assert.match(gallerySource, /event\.key === "ArrowLeft"/);
  assert.match(gallerySource, /event\.key === "ArrowRight"/);
  assert.match(gallerySource, /startsWith\("image\/"\)[\s\S]*startsWith\("video\/"\)/);
  assert.match(gallerySource, /controls autoPlay playsInline/);
  assert.match(gallerySource, /下载原文件/);
});

test("gallery previews preserve the complete media frame", () => {
  const mediaRule = globalStyles.match(/\.cloud-gallery img,[\s\S]*?\{([^}]+)\}/)?.[1] ?? "";
  const dialogRule = globalStyles.match(/\.output-preview-dialog__media img,[\s\S]*?\{([^}]+)\}/)?.[1] ?? "";

  assert.match(mediaRule, /object-fit:\s*contain\s*;/);
  assert.match(dialogRule, /object-fit:\s*contain\s*;/);
  assert.match(globalStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.gallery-media-button/);
});
