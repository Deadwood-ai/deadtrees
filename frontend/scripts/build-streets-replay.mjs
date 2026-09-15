/* global fetch */
// Build an offline rendering comparison from two fixed public Streets tiles.
// node scripts/build-streets-replay.mjs /absolute/output
// Then serve with serve-map-benchmark.mjs and compare /?mode=original and
// /?mode=full. Reapply CPU throttling before each navigation and verify the
// actual viewport. This isolates building rendering, not full page loading.
import { build } from "vite";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const output = process.argv[2];
if (!output?.startsWith("/"))
  throw new Error("Pass an absolute output directory");
await mkdir(output, { recursive: true });
const marker = join(output, ".streets-replay-build");
const signature = "DeadTrees disposable Streets replay build\n";
if (
  (await readdir(output)).length &&
  (await readFile(marker, "utf8").catch(() => "")) !== signature
) {
  throw new Error("Output must be empty or an existing Streets replay build");
}
await writeFile(marker, signature);
const tiles = [
  [
    "14-12303-7076",
    "610a2077d9b7515f82c3b073311c37d827104ab583c2e0051b1ce8fd5560544b",
  ],
  [
    "14-12304-7076",
    "af543e4e311ac64e680caa403f7ecc37feaf3e804a53f9a46f3bbdb37bf4c05a",
  ],
];
for (const [name, expectedHash] of tiles) {
  const file = join(output, `${name}.pbf`);
  let data = await readFile(file).catch(() => null);
  if (!data) {
    const url = `https://tiles.openfreemap.org/planet/20260913_164504_pt/${name.replaceAll("-", "/")}.pbf`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Fixture request failed: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(data).digest("hex") !== expectedHash) {
    throw new Error(`Fixture checksum mismatch: ${name}`);
  }
  await writeFile(file, data);
}
const input = await mkdtemp(join(tmpdir(), "dt-streets-replay-"));
try {
  await writeFile(
    join(input, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Streets building replay</title><style>html,body,#map{margin:0;width:100%;height:100%}#summary{position:absolute;top:8px;left:8px;z-index:5;background:white;padding:10px;font:14px sans-serif}</style></head><body><div id="map"></div><div id="summary">Loading local Streets fixture…</div><script type="module" src="/replay.js"></script><div style="position:absolute;bottom:4px;right:4px;background:white;font:12px sans-serif">OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors</div></body></html>`,
  );
  await writeFile(
    join(input, "replay.js"),
    await readFile(resolve(import.meta.dirname, "streets-replay.js")),
  );
  await build({
    configFile: false,
    root: input,
    resolve: {
      alias: { ol: resolve(import.meta.dirname, "../node_modules/ol") },
    },
    build: { outDir: output, emptyOutDir: false },
  });
} finally {
  await rm(input, { recursive: true });
}
