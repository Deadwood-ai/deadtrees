import { describe, expect, it } from "vitest";
import Collection from "ol/Collection.js";
import Interaction from "ol/interaction/Interaction.js";
import { lockMapInteractions } from "./mapInteractionLock";

function mapWith(...states: boolean[]) {
  const interactions = states.map((active) => {
    const interaction = new Interaction();
    interaction.setActive(active);
    return interaction;
  });
  return { map: { getInteractions: () => new Collection(interactions) }, interactions };
}

describe("lockMapInteractions", () => {
  it("restores only the interactions that were active", () => {
    const { map, interactions } = mapWith(true, false, true);
    const unlock = lockMapInteractions(map);
    expect(interactions.map((i) => i.getActive())).toEqual([false, false, false]);
    unlock();
    expect(interactions.map((i) => i.getActive())).toEqual([true, false, true]);
  });

  it("does nothing when unlocked twice or locked while already locked", () => {
    const { map, interactions } = mapWith(true, false);
    const unlockOuter = lockMapInteractions(map);
    const unlockInner = lockMapInteractions(map);
    unlockInner();
    expect(interactions.map((i) => i.getActive())).toEqual([false, false]);
    unlockOuter();
    unlockOuter();
    expect(interactions.map((i) => i.getActive())).toEqual([true, false]);
  });
});
