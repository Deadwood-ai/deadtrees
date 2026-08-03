import { describe, expect, it } from "vitest";

import {
  LIVE_IMAGERY_MODE,
  imageryModeReducer,
} from "./imageryMode";

describe("imageryModeReducer", () => {
  it("keeps pending history intent until current candidates select a release", () => {
    const discovering = imageryModeReducer(LIVE_IMAGERY_MODE, {
      type: "browse-history",
    });

    expect(discovering).toEqual({ kind: "discovering" });
    expect(
      imageryModeReducer(discovering, {
        type: "select-release",
        releaseNum: 7110,
      }),
    ).toEqual({ kind: "historical", releaseNum: 7110 });
  });

  it("returns to live imagery from pending or selected history", () => {
    expect(
      imageryModeReducer({ kind: "discovering" }, { type: "use-live" }),
    ).toEqual(LIVE_IMAGERY_MODE);
    expect(
      imageryModeReducer(
        { kind: "historical", releaseNum: 7110 },
        { type: "use-live" },
      ),
    ).toEqual(LIVE_IMAGERY_MODE);
  });
});
