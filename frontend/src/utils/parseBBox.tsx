type BBox = [[number, number], [number, number]]; // [minLongitude, minLatitude, maxLongitude, maxLatitude]

function parseBBox(boxString: string): BBox | null {
  // console.log("boxString: ", boxString);
  const regex = /BOX\((-?\d+\.\d+) (-?\d+\.\d+),(-?\d+\.\d+) (-?\d+\.\d+)\)/;
  const matches = boxString.match(regex);
  // console.log("matches: ", matches);

  if (!matches) return null;

  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = matches.slice(1).map(Number);

  return [minLongitude, minLatitude, maxLongitude, maxLatitude];
}
export default parseBBox;
