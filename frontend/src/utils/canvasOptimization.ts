/**
 * Patches the HTML Canvas getContext method to always use willReadFrequently=true
 * This improves performance for canvas operations that frequently read pixel data
 * but may decrease performance for operations that primarily write to the canvas.
 *
 * This is particularly useful for OpenLayers maps that perform frequent hit detection.
 *
 * @see https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently
 */
export function applyCanvasOptimization() {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    contextType: string,
    contextAttributes?: CanvasRenderingContext2DSettings,
  ) {
    // Only modify 2d context
    if (contextType === "2d") {
      // Create attributes object if it doesn't exist
      contextAttributes = contextAttributes || {};
      // Set willReadFrequently to true for all 2d contexts
      contextAttributes.willReadFrequently = true;
    }
    // Call the original method with our modified attributes
    return originalGetContext.call(this, contextType, contextAttributes);
  };

  console.debug("[Canvas Optimization] Applied willReadFrequently=true to all 2D canvas contexts");
}
