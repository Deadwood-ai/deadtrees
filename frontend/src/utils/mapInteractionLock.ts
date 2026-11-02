import type Map from "ol/Map.js";
import type Interaction from "ol/interaction/Interaction.js";

/**
 * Switches off the map's active interactions and returns a function that turns exactly
 * those back on. Interactions that were inactive before (other draw or edit tools) stay off.
 */
export function lockMapInteractions(map: Pick<Map, "getInteractions">): () => void {
  const active: Interaction[] = map
    .getInteractions()
    .getArray()
    .filter((i) => i.getActive());
  active.forEach((i) => i.setActive(false));
  return () => active.forEach((i) => i.setActive(true));
}
