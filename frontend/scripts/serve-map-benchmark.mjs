// Serve an instrumented build on a fixed, loopback-only origin (no port fallback).
// node scripts/serve-map-benchmark.mjs /absolute/build 61682
// Keep baseline/candidate origins stable across experiments. In browser profiling,
// verify actual viewport/DPR and resize history, bypass the service worker, and
// disable HTTP cache for cold runs; enable cache for explicitly separate warm runs.
// Record first imagery, rendercomplete after tile responses, and final pixels.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { gzipSync } from "node:zlib";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const root = resolve(process.argv[2] ?? "");
const port = Number(process.argv[3]);
if (
  !process.argv[2]?.startsWith("/") ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
) {
  throw new Error(
    "Pass an absolute build directory and a fixed unprivileged port",
  );
}
if (!existsSync(resolve(root, "index.html")))
  throw new Error("Build index.html is missing");
const types = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
http
  .createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    let file = resolve(root, `.${pathname}`);
    if (
      !file.startsWith(`${root}/`) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      // SPA routes use the build's index; absent assets must fail visibly.
      if (pathname.startsWith("/assets/")) {
        response.writeHead(404).end();
        return;
      }
      file = resolve(root, "index.html");
    }
    const extension = extname(file);
    const compress =
      /gzip/.test(request.headers["accept-encoding"] ?? "") &&
      [".html", ".js", ".css", ".json", ".svg"].includes(extension);
    const content = readFileSync(file);
    const body = compress ? gzipSync(content) : content;
    response.writeHead(200, {
      "Content-Type": types[extension] ?? "application/octet-stream",
      "Cache-Control":
        extension === ".html" ? "no-cache" : "public,max-age=3600",
      "Content-Length": body.length,
      Vary: "Accept-Encoding",
      ...(compress ? { "Content-Encoding": "gzip" } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  })
  .listen(port, "127.0.0.1", () => {
    console.info(`Map benchmark: http://127.0.0.1:${port}`);
  });
