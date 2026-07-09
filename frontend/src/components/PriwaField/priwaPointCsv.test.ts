import { describe, expect, it } from "vitest";

import { priwaPointsToCsv } from "./priwaPointCsv";
import type { IPriwaPoint } from "./types";

const basePoint: IPriwaPoint = {
  id: "point-1",
  baumnr: "B-17",
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "nein",
  harz: "nein",
  grueneNadelnAmBoden: "ja",
  nadel: "fahlgrün/gelblich",
  rinde: "bis25%",
  kv: "0%",
  name: "Sigi Huber",
  datum: "2026-07-07",
  kom: 'Nahe "Rückeweg"',
  capturedAt: "2026-07-07T08:30:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
  isEstimatedLocation: false,
  lat: 48.12345,
  lon: 8.54321,
};

describe("priwaPointsToCsv", () => {
  it("exports PRIWA points with all field columns and escaped text", () => {
    expect(priwaPointsToCsv([basePoint]).split("\n")).toEqual([
      '"id","baumnr","fund","baumart","bohrmehl","bohrloch","harz","gruene_nadeln_am_boden","nadelverfaerbung","rindenverlust","nadelverlust","name","datum","latitude","longitude","coordinate_source","is_estimated_location","captured_at","kommentar","sync_status"',
      '"point-1","B-17","ja","Fichte","ja","nein","nein","ja","fahlgrün/gelblich","bis25%","0%","Sigi Huber","2026-07-07","48.12345","8.54321","qr","false","2026-07-07T08:30:00.000Z","Nahe ""Rückeweg""","synced"',
    ]);
  });
});
