import { describe, expect, it } from "vitest";
import { IDataAccess } from "../../types/dataset";
import { visibilityReductionNotice } from "./accessCopy";

const { public: Public, viewonly: ViewOnly, private: Private } = IDataAccess;

describe("visibilityReductionNotice", () => {
  it.each([
    [Public, ViewOnly],
    [Public, Private],
    [ViewOnly, Private],
  ])("warns about existing exports when %s becomes %s", (current, next) => {
    expect(visibilityReductionNotice(current, next)).toMatch(/published data packages and releases, which keep it/);
  });

  it("names who keeps access when a dataset becomes private", () => {
    expect(visibilityReductionNotice(Public, Private)).toMatch(/^People you shared the dataset with keep their access/);
    expect(visibilityReductionNotice(Public, ViewOnly)).toMatch(/^Only you and people you allow can download/);
  });

  it.each([
    [Private, ViewOnly],
    [Private, Public],
    [ViewOnly, Public],
    [Public, Public],
    [Public, undefined],
    [null, Private],
  ])("stays silent when %s becomes %s", (current, next) => {
    expect(visibilityReductionNotice(current, next)).toBeNull();
  });
});
