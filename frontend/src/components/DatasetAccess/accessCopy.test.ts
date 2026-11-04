import { describe, expect, it } from "vitest";
import { IDataAccess } from "../../types/dataset";
import { datasetAccountLink, visibilityReductionNotice } from "./accessCopy";

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

describe("datasetAccountLink", () => {
  it("sends the owner to their row in My datasets", () => {
    expect(datasetAccountLink({ is_owner: true, role: null }, 7)).toEqual({
      to: "/profile?highlight=7",
      label: "Manage in My datasets",
    });
  });

  it.each([
    ["reader", "Find in Shared with me"],
    ["editor", "Manage in Shared with me"],
    ["admin", "Manage in Shared with me"],
  ] as const)("sends a %s to their row in Shared with me", (role, label) => {
    expect(datasetAccountLink({ is_owner: false, role }, 7)).toEqual({ to: "/profile?tab=shared&highlight=7", label });
  });

  it("gives operators without a stake in the dataset no link", () => {
    expect(datasetAccountLink({ is_owner: false, role: null }, 7)).toBeNull();
  });
});
