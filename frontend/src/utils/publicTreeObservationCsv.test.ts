import { describe, expect, it } from "vitest";

import { publicTreeObservationsToCsv } from "./publicTreeObservationCsv";

describe("publicTreeObservationsToCsv", () => {
  it("exports public tree observations with escaped text fields", () => {
    expect(
      publicTreeObservationsToCsv([
        {
          id: "obs-1",
          createdAt: "2026-06-11T10:00:00.000Z",
          lat: 50.123456,
          lon: 8.654321,
          condition: "dead",
          treeTypeGroup: "conifer",
          treeTypeText: 'Norway "spruce"',
          comment: "student group, plot 1",
          clientId: null,
        },
      ]),
    ).toBe(
      [
        '"id","created_at","latitude","longitude","condition","condition_label","tree_type_group","tree_type_label","specific_species_name","comment"',
        '"obs-1","2026-06-11T10:00:00.000Z","50.123456","8.654321","dead","Dead / brown or grey standing tree","conifer","Needleleaf / conifer","Norway ""spruce""","student group, plot 1"',
      ].join("\n"),
    );
  });
});
