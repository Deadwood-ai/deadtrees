"""Choosing ODM input images (DT-1312): paired DNGs, multispectral bands, GPS outliers, extent."""

from pathlib import Path

import pytest
from PIL import Image

from processor.src.utils.odm_inputs import (
	OdmInputError,
	drop_gps_outliers,
	drop_multispectral_bands,
	drop_paired_raw_images,
	gps_extent_km2,
	read_gps_position,
	select_odm_images,
)

pytestmark = pytest.mark.unit

FLIGHT = (48.0, 7.85)


def _dms(value: float) -> tuple[float, float, float]:
	value = abs(value)
	degrees = int(value)
	minutes = int((value - degrees) * 60)
	return float(degrees), float(minutes), (value - degrees - minutes / 60) * 3600


def _photo(path: Path, position: tuple[float, float] | None = None, mode: str = 'RGB') -> Path:
	image = Image.new(mode, (8, 8))
	exif = Image.Exif()
	if position is not None:
		latitude, longitude = position
		exif.get_ifd(0x8825).update(
			{1: 'N' if latitude >= 0 else 'S', 2: _dms(latitude), 3: 'E' if longitude >= 0 else 'W', 4: _dms(longitude)}
		)
	image.save(path, exif=exif)
	return path


def _grid(count: int, spacing_degrees: float = 0.0005) -> list[tuple[float, float]]:
	return [(FLIGHT[0] + (i // 5) * spacing_degrees, FLIGHT[1] + (i % 5) * spacing_degrees) for i in range(count)]


def test_paired_dng_is_dropped_and_lone_dng_kept(tmp_path):
	files = [tmp_path / 'DJI_0001.JPG', tmp_path / 'DJI_0001.DNG', tmp_path / 'DJI_0002.dng']

	kept, dropped = drop_paired_raw_images(files)

	assert kept == [tmp_path / 'DJI_0001.JPG', tmp_path / 'DJI_0002.dng']
	assert dropped == [tmp_path / 'DJI_0001.DNG']


def test_p4_multispectral_band_tifs_are_dropped_next_to_rgb_frames(tmp_path):
	rgb = _photo(tmp_path / 'DJI_0010.JPG')
	bands = [_photo(tmp_path / f'DJI_001{i}.TIF', mode='I;16') for i in range(1, 6)]
	m3m_band = _photo(tmp_path / 'DJI_20260814112011_0103_MS_G.TIF', mode='L')

	kept, dropped = drop_multispectral_bands([rgb, *bands, m3m_band])

	assert kept == [rgb]
	assert set(dropped) == {*bands, m3m_band}


def test_band_only_sets_are_left_empty(tmp_path):
	bands = [_photo(tmp_path / f'IMG_{i}_GRE.TIF', mode='L') for i in range(3)]
	rgb_tif = _photo(tmp_path / 'ortho_frame.tif')

	kept, dropped = drop_multispectral_bands([*bands, rgb_tif])

	assert kept == [rgb_tif]
	assert dropped == bands


def test_read_gps_position_round_trips_exif(tmp_path):
	position = read_gps_position(_photo(tmp_path / 'a.jpg', (-33.5, -70.25)))

	assert position == pytest.approx((-33.5, -70.25), abs=1e-6)
	assert read_gps_position(_photo(tmp_path / 'b.jpg')) is None


def test_failed_fix_and_far_away_frame_are_dropped():
	positions = {Path(f'{i}.jpg'): p for i, p in enumerate(_grid(20))}
	positions[Path('zero.jpg')] = (0.0, 0.0)
	positions[Path('far.jpg')] = (FLIGHT[0] + 0.5, FLIGHT[1])

	kept, outliers = drop_gps_outliers(positions)

	assert set(outliers) == {Path('zero.jpg'), Path('far.jpg')}
	assert len(kept) == 20


def test_one_broken_fix_is_dropped_even_in_a_small_flight():
	positions = {Path(f'{i}.jpg'): p for i, p in enumerate(_grid(5))}
	positions[Path('zero.jpg')] = (0.0, 0.0)

	kept, outliers = drop_gps_outliers(positions)

	assert outliers == [Path('zero.jpg')]
	assert len(kept) == 5


def test_failed_fixes_are_dropped_even_beyond_the_outlier_share():
	positions = {Path(f'{i}.jpg'): p for i, p in enumerate(_grid(8))}
	positions |= {Path('zero1.jpg'): (0.0, 0.0), Path('zero2.jpg'): (0.0, 0.0)}

	kept, outliers = drop_gps_outliers(positions)

	assert outliers == [Path('zero1.jpg'), Path('zero2.jpg')]
	assert len(kept) == 8


def test_dji_xmp_position_wins_over_exif_like_in_odm(tmp_path):
	photo = _photo(tmp_path / 'a.jpg', FLIGHT)
	xmp = b'<x:xmpmeta><rdf:Description drone-dji:Latitude="+0.000000" drone-dji:Longitude="+0.000000"/></x:xmpmeta>'
	photo.write_bytes(photo.read_bytes() + xmp)

	assert read_gps_position(photo) == (0.0, 0.0)


def test_two_sites_are_a_real_spread_not_outliers():
	positions = {Path(f'a{i}.jpg'): p for i, p in enumerate(_grid(10))}
	positions |= {Path(f'b{i}.jpg'): (p[0] + 1.0, p[1]) for i, p in enumerate(_grid(10))}

	kept, outliers = drop_gps_outliers(positions)

	assert outliers == []
	assert kept == positions


def test_gps_extent_km2_adds_the_image_footprint():
	side = 1000 / 111_320
	square = [FLIGHT, (FLIGHT[0] + side, FLIGHT[1] + side / 0.6691306)]
	assert gps_extent_km2(square) == pytest.approx(1.2 * 1.2, rel=0.01)
	assert gps_extent_km2([FLIGHT]) == pytest.approx(0.04, rel=0.01)


def test_a_long_straight_line_still_counts_as_a_large_extent():
	# 300 km north-south with no east-west spread: a bare bounding box would be 0 km².
	assert gps_extent_km2([FLIGHT, (FLIGHT[0] + 2.7, FLIGHT[1])]) > 30


def test_lone_distant_frame_is_dropped_in_a_four_image_set():
	positions = {Path(f'{i}.jpg'): p for i, p in enumerate(_grid(3))}
	positions[Path('far.jpg')] = (FLIGHT[0] + 0.5, FLIGHT[1])

	kept, outliers = drop_gps_outliers(positions)

	assert outliers == [Path('far.jpg')]
	assert len(kept) == 3


def test_select_odm_images_keeps_the_usable_flight(tmp_path):
	frames = [_photo(tmp_path / f'DJI_{i:04d}.JPG', p) for i, p in enumerate(_grid(20))]
	raw = tmp_path / 'DJI_0000.DNG'
	raw.write_bytes(b'raw')
	stray = _photo(tmp_path / 'DJI_9999.JPG', (0.0, 0.0))

	selection = select_odm_images([*frames, raw, stray], max_extent_km2=30)

	assert selection.kept == frames
	assert list(selection.dropped.values()) == [[raw], [stray]]
	assert selection.extent_km2 < 1


def test_select_odm_images_rejects_an_area_too_large_for_one_mosaic(tmp_path):
	frames = [_photo(tmp_path / f'a{i}.jpg', p) for i, p in enumerate(_grid(10))]
	frames += [_photo(tmp_path / f'b{i}.jpg', (p[0] + 0.1, p[1] + 0.1)) for i, p in enumerate(_grid(10))]

	with pytest.raises(OdmInputError, match='upload each site'):
		select_odm_images(frames, max_extent_km2=30)


def test_select_odm_images_records_band_drops_under_the_shared_reason(tmp_path):
	rgb = _photo(tmp_path / 'DJI_0010.JPG')
	band = _photo(tmp_path / 'DJI_0011.TIF', mode='L')

	selection = select_odm_images([rgb, band], max_extent_km2=30)

	assert selection.dropped == {'multispectral band images': [band]}


def test_select_odm_images_rejects_band_only_uploads(tmp_path):
	bands = [_photo(tmp_path / f'IMG_{i}_GRE.TIF', mode='L') for i in range(3)]

	with pytest.raises(OdmInputError, match='only contains multispectral band images'):
		select_odm_images(bands, max_extent_km2=30)


def test_band_only_upload_fails_before_any_odm_container(tmp_path, monkeypatch):
	from processor.src import process_odm

	class _NoDocker:
		volumes = None

	monkeypatch.setattr(process_odm.docker, 'from_env', lambda **_: _NoDocker())
	for i in range(3):
		_photo(tmp_path / f'DJI_20260814112011_000{i}_MS_G.TIF', mode='L')

	with pytest.raises(OdmInputError, match='only contains multispectral band images'):
		process_odm._run_odm_container(tmp_path, tmp_path / 'out', token='test', dataset_id=0)
