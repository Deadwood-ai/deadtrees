type BBox = [number, number, number, number]; // [minLongitude, minLatitude, maxLongitude, maxLatitude]

function parseBBox(boxString: string): BBox | null {
  const coordinate = "-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const regex = new RegExp(
    `^BOX\\((${coordinate})\\s+(${coordinate}),\\s*(${coordinate})\\s+(${coordinate})\\)$`,
  );
  const matches = boxString.match(regex);

  if (!matches) return null;

  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = matches
    .slice(1)
    .map(Number);

  return [minLongitude, minLatitude, maxLongitude, maxLatitude];
}
export default parseBBox;
