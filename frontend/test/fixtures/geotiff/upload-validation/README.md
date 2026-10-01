These fixtures are tiny crops derived from real archive files so upload validation can be tested against the same TIFF structures we see in production, without checking large contributor files into the repo.

Source datasets:
- `rgb-real-crop.tif`: cropped from `/home/jj1049/mount_storage_server/archive/1000_ortho.tif`
- `rgba-real-crop.tif`: cropped from `/home/jj1049/mount_storage_server/archive/8781_ortho.tif`
- `red-alpha-real-crop.tif`: cropped from `/home/jj1049/mount_storage_server/archive/8770_ortho.tif`
- `nir-alpha-real-crop.tif`: cropped from `/home/jj1049/mount_storage_server/archive/8772_ortho.tif`
- `no-crs-coordinates-real-crop.tif`: cropped from `/home/jj1049/mount_storage_server/archive/3781_ortho.tif`, a past upload with coordinates but no CRS
- `no-georeference-real-crop.tif`: cropped from `/home/jj1049/mount_storage_server/archive/10079_ortho.tif`, a past upload with no georeferencing at all

They are regenerated with:

```bash
scripts/generate-upload-validation-fixtures.sh
```

Each fixture is a `64x64` crop created with `gdal_translate -srcwin 0 0 64 64 ...` so the TIFF header, sample count, and photometric interpretation are preserved while the test payload stays small.
