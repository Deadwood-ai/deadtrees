import { fromUrl } from "geotiff";

export interface PixelResult {
  value: number;
  cellBounds: [number, number, number, number]; // [minX, minY, maxX, maxY] in map coordinates
}

const getPixelValueOfCoordinate = async ({
  coordinates,
  cogUrl,
}: {
  coordinates: number[];
  cogUrl: string;
}): Promise<PixelResult> => {
  // load image
  const tiff = await fromUrl(cogUrl);
  const image = await tiff.getImage();

  // get raster metadata
  const width = image.getWidth();
  const height = image.getHeight();
  const [originX, originY] = image.getOrigin();
  const [xSize, ySize] = image.getResolution(); // ySize is typically negative for north-up rasters

  const uWidth = xSize * width;
  const uHeight = ySize * height;

  // calculate pixel coordinates
  const x = Math.floor(((coordinates[0] - originX) / uWidth) * width);
  const y = Math.floor(((coordinates[1] - originY) / uHeight) * height);

  // calculate cell bounds in map coordinates
  const cellMinX = originX + x * xSize;
  const cellMaxX = originX + (x + 1) * xSize;
  // ySize is negative, so minY and maxY are swapped
  const cellMinY = originY + (y + 1) * ySize;
  const cellMaxY = originY + y * ySize;

  // read pixel value
  const values = await image.readRasters({ interleave: true, window: [x, y, x + 1, y + 1], samples: [0] });

  return {
    value: values[0] as number,
    cellBounds: [cellMinX, cellMinY, cellMaxX, cellMaxY],
  };
};

export default getPixelValueOfCoordinate;
