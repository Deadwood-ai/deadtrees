// Loaded only by build-map-benchmark.mjs, before application modules.
// Milestones are diagnostic evidence; verify final pixels as well as timings.
/* global window, performance, PerformanceObserver, CanvasRenderingContext2D, innerWidth, innerHeight, devicePixelRatio, URL */
(() => {
  const maps = new Set();
  const longTasks = [];
  const draws = [];
  const completions = [];
  const viewportChanges = [];
  const recordViewport = () =>
    viewportChanges.push({
      time: performance.now(),
      width: innerWidth,
      height: innerHeight,
      pixelRatio: devicePixelRatio,
    });
  recordViewport();
  window.addEventListener("resize", recordViewport);
  const seen = new WeakSet();
  performance.setResourceTimingBufferSize(4000);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push([entry.startTime, entry.duration]);
  }).observe({ type: "longtask", buffered: true });
  for (const type of [
    window.WebGLRenderingContext,
    window.WebGL2RenderingContext,
  ]) {
    if (!type) continue;
    for (const method of ["drawElements", "drawArrays"]) {
      const original = type.prototype[method];
      type.prototype[method] = function (...args) {
        const result = original.apply(this, args);
        if (
          this.canvas.width > 256 &&
          !seen.has(this.canvas) &&
          !this.getParameter(this.FRAMEBUFFER_BINDING)
        ) {
          const drawnAt = performance.now();
          const pixels = new Uint8Array(
            this.canvas.width * this.canvas.height * 4,
          );
          this.readPixels(
            0,
            0,
            this.canvas.width,
            this.canvas.height,
            this.RGBA,
            this.UNSIGNED_BYTE,
            pixels,
          );
          // A draw call can be an empty/nodata tile. Count actual image pixels,
          // not canvas creation or a transparent first tile, as useful imagery.
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              pixels[i + 3] &&
              (pixels[i] || pixels[i + 1] || pixels[i + 2])
            ) {
              seen.add(this.canvas);
              draws.push({
                kind: "imagery",
                time: drawnAt,
                pixelCheckMs: performance.now() - drawnAt,
              });
              break;
            }
          }
        }
        return result;
      };
    }
  }
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const result = drawImage.apply(this, args);
    const kind = this.canvas.parentElement?.className ?? "";
    if (
      /forest-cover-vector|deadwood-vector/.test(kind) &&
      !seen.has(this.canvas)
    ) {
      seen.add(this.canvas);
      draws.push({ kind, time: performance.now() });
    }
    return result;
  };
  window.__mapBenchmark = {
    attach(map) {
      maps.add(new WeakRef(map));
      map.on("rendercomplete", () => {
        completions.push({
          time: performance.now(),
          target: !!map.getTargetElement(),
          zoom: map.getView().getZoom(),
        });
      });
    },
    reset() {
      longTasks.length = draws.length = completions.length = 0;
      performance.clearResourceTimings();
      this.start = performance.now();
    },
    start: 0,
    snapshot() {
      const live = [...maps]
        .map((ref) => ref.deref())
        .filter((map) => map?.getTargetElement());
      return {
        start: this.start,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          pixelRatio: devicePixelRatio,
        },
        draws,
        longTasks,
        completions,
        viewportChanges,
        maps: live.map((map) => ({
          zoom: map.getView().getZoom(),
          size: map.getSize(),
          center: map.getView().getCenter(),
          loading: map.getLoadingOrNotReady(),
          layers: map.getAllLayers().map((layer) => ({
            kind: layer.getClassName(),
            visible: layer.isVisible(map.getView()),
            source: layer.getSource()?.getState(),
          })),
        })),
        resources: performance.getEntriesByType("resource").map((entry) => ({
          path: new URL(entry.name).pathname,
          start: entry.startTime,
          end: entry.responseEnd,
          duration: entry.duration,
          bytes: entry.transferSize,
          status: entry.responseStatus,
        })),
      };
    },
  };
})();
