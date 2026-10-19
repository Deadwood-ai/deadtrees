import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

Image = pytest.importorskip('PIL.Image')

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import disturbance_benchmark_publish as publish


def _jpeg(path: Path, size: tuple[int, int], noisy: bool) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	pixels = os.urandom(size[0] * size[1] * 3) if noisy else bytes(size[0] * size[1] * 3)
	Image.frombytes('RGB', size, pixels).save(path, quality=95)


def _run(tmp_path: Path, extra_reference: str | None = None) -> Path:
	export = tmp_path / 'runs' / 'run-1' / 'export'
	_jpeg(export / 'Site_A' / 'drone.jpg', (1200, 900), noisy=True)
	_jpeg(export / 'Site_A' / 'planet_monthly-0.jpg', (80, 60), noisy=False)
	mask = Image.new('RGBA', (40, 30), (0, 0, 0, 0))
	mask.putpixel((3, 4), (255, 128, 0, 255))
	mask.save(export / 'Site_A' / 'dte-prediction.png')
	site = {
		'id': 'Site_A',
		'drone': '/data/Site_A/drone.jpg',
		'products': [{'id': 'dte', 'prediction': '/data/Site_A/dte-prediction.png'}],
		'contexts': {'planet': [{'date': '2024-01', 'image': '/data/Site_A/planet_monthly-0.jpg'}]},
		'referencePolygons': {'features': [{'geometry': {'coordinates': [[[0.123456789, 0.987654321]]]}}]},
		'series': [{'date': '2024-01-01', 'ndvi': 0.123456789}],
	}
	if extra_reference:
		site['notes'] = [extra_reference]
	(export / 'Site_A' / 'site.json').write_text(json.dumps(site))
	(export / 'catalog.json').write_text(json.dumps({'sites': [{'id': 'Site_A', 'detail': '/data/Site_A/site.json'}]}))
	(export.parent / 'handoff-audit.json').write_text(json.dumps({'missingReferences': []}))
	return export.parent


def test_build_converts_images_and_rewrites_paths(tmp_path, monkeypatch):
	monkeypatch.setattr(publish, 'PREVIEW_MIN_BYTES', 10_000)
	run = _run(tmp_path)
	out = publish.build(run, builds_root=tmp_path / 'builds', workers=2)

	site = json.loads((out / 'Site_A' / 'site.json').read_text())
	assert site['drone'] == '/data/Site_A/drone.webp'
	assert site['dronePreview'] == '/data/Site_A/drone.preview.webp'
	assert site['products'][0]['prediction'] == '/data/Site_A/dte-prediction.webp'
	frame = site['contexts']['planet'][0]
	assert frame['image'] == '/data/Site_A/planet_monthly-0.webp'
	assert 'preview' not in frame  # small frames are cheaper without a second copy
	# Display geometry is rounded; measurements are left as supplied.
	assert site['referencePolygons']['features'][0]['geometry']['coordinates'] == [[[0.12346, 0.98765]]]
	assert site['series'][0]['ndvi'] == 0.123456789

	with Image.open(out / 'Site_A' / 'drone.preview.webp') as preview:
		assert max(preview.size) == publish.PREVIEW_MAX_SIDE
	with Image.open(out / 'Site_A' / 'dte-prediction.webp') as mask:
		assert mask.convert('RGBA').getpixel((3, 4)) == (255, 128, 0, 255)  # lossless
		assert mask.convert('RGBA').getpixel((0, 0))[3] == 0
	assert not list(out.rglob('*.jpg')) and not list(out.rglob('*.png'))
	assert json.loads((out / 'build.json').read_text())['previews'] == 1


def test_build_refuses_a_run_with_dangling_references(tmp_path):
	run = _run(tmp_path, extra_reference='/data/Site_A/missing.jpg')
	with pytest.raises(SystemExit, match='1 referenced files are missing'):
		publish.build(run, builds_root=tmp_path / 'builds', workers=2)
	assert not (tmp_path / 'builds' / 'run-1').exists()


def test_newest_run_skips_runs_with_missing_references(tmp_path):
	good = _run(tmp_path)
	bad = tmp_path / 'runs' / 'run-2'
	(bad / 'export').mkdir(parents=True)
	(bad / 'export' / 'catalog.json').write_text('{}')
	(bad / 'handoff-audit.json').write_text(json.dumps({'missingReferences': ['x']}))
	assert publish.newest_run(tmp_path / 'runs') == good


def test_publish_links_unchanged_files_and_switch_rolls_back(tmp_path, monkeypatch):
	remote = tmp_path / 'remote'
	remote.mkdir()
	monkeypatch.setattr(publish, 'REMOTE', f'{remote}/')
	monkeypatch.setattr(publish, 'BUILDS_ROOT', tmp_path / 'builds')
	first = _run(tmp_path)
	publish.publish(first)
	assert os.readlink(remote / 'current') == 'run-1'

	second = tmp_path / 'runs' / 'run-2'
	(tmp_path / 'runs' / 'run-1').rename(second)
	publish.publish(second)
	assert os.readlink(remote / 'current') == 'run-2'
	# Unchanged files share storage with the previous version.
	assert (remote / 'run-2' / 'Site_A' / 'drone.webp').stat().st_ino == (
		remote / 'run-1' / 'Site_A' / 'drone.webp'
	).stat().st_ino

	publish.switch('run-1')
	assert os.readlink(remote / 'current') == 'run-1'
	with pytest.raises(subprocess.CalledProcessError):
		publish.switch('never-uploaded')
