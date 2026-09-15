// Opt-in production build instrumentation. Never included by `npm run build`.
// Usage: node scripts/build-map-benchmark.mjs /absolute/output <prod|dev>
// For dev, first source the verified isolated current.env from the repo's QA setup.
// Prod uses public frontend configuration; keep browser actions read-only.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import process from "node:process";
import { URL } from "node:url";

const outDir = process.argv[2];
if (!outDir?.startsWith("/"))
  throw new Error("Pass an absolute output directory");
const profile = process.argv[3];
if (!["prod", "dev"].includes(profile))
  throw new Error("Choose prod or dev explicitly");
if (
  profile === "dev" &&
  !["127.0.0.1", "localhost"].includes(
    new URL(process.env.VITE_SUPABASE_URL ?? "http://missing").hostname,
  )
)
  throw new Error(
    "Source the verified isolated QA environment before building dev",
  );
process.env.VITE_MODE = profile === "prod" ? "production" : "development";
await mkdir(outDir, { recursive: true });
const marker = resolve(outDir, ".map-benchmark-build");
const signature = "DeadTrees disposable map benchmark build\n";
if (
  (await readdir(outDir)).length &&
  (await readFile(marker, "utf8").catch(() => "")) !== signature
) {
  throw new Error("Output must be empty or an existing map benchmark build");
}
await writeFile(marker, signature);
// Tailwind resolves its content globs relative to cwd, just like the normal build.
process.chdir(resolve(import.meta.dirname, ".."));
const probe = await readFile(
  new URL("./map-benchmark-probe.js", import.meta.url),
  "utf8",
);
await build({
  root: resolve(import.meta.dirname, ".."),
  mode: profile,
  build: { outDir, emptyOutDir: false },
  plugins: [
    {
      name: "map-benchmark",
      enforce: "pre",
      transformIndexHtml: {
        order: "pre",
        handler: () => [
          { tag: "script", children: probe, injectTo: "head-prepend" },
        ],
      },
      transform(code, id) {
        if (!id.endsWith("/ol/Map.js")) return;
        const marker = "constructor(options) {\n    super();";
        if (!code.includes(marker))
          throw new Error("OpenLayers benchmark constructor changed");
        return code.replace(
          marker,
          `${marker}\n    queueMicrotask(() => window.__mapBenchmark.attach(this));`,
        );
      },
    },
  ],
});
