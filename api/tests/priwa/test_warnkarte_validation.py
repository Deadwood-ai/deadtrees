from io import BytesIO
from pathlib import Path

import fiona
import pytest
from shapely.geometry import Polygon, mapping

from api.src.priwa import warnkarte as warnkarte_module
from api.src.priwa.warnkarte import WarnkarteValidationError, validate_warnkarte_file


pytestmark = pytest.mark.unit


def write_warnkarte(
	path: Path,
	*,
	crs: str | None = 'EPSG:32632',
	properties: dict[str, str] | None = None,
	geometry_type: str = 'Polygon',
	probabilities: tuple[object, ...] = (0.0, 0.6000000238, 1.0),
	geometries: tuple[Polygon | None, ...] | None = None,
	layer: str = 'warning_polygons_2023-01-01',
) -> Path:
	schema = {
		'geometry': geometry_type,
		'properties': properties if properties is not None else {'probability': 'float'},
	}
	if geometries is None:
		geometries = tuple(
			Polygon(
				[
					(450000 + index * 20, 5360000),
					(450010 + index * 20, 5360000),
					(450010 + index * 20, 5360010),
					(450000 + index * 20, 5360010),
					(450000 + index * 20, 5360000),
				]
			)
			for index in range(len(probabilities))
		)

	with fiona.open(
		path,
		mode='w',
		driver='GPKG',
		layer=layer,
		crs=crs,
		schema=schema,
	) as sink:
		for index, (probability, geometry) in enumerate(zip(probabilities, geometries, strict=True)):
			row_properties = {name: None for name in schema['properties']}
			if 'probability' in row_properties:
				row_properties['probability'] = probability
			sink.write(
				{
					'id': str(index + 1),
					'geometry': mapping(geometry) if geometry is not None else None,
					'properties': row_properties,
				}
			)
	return path


def validate_path(path: Path):
	with path.open('rb') as source:
		return validate_warnkarte_file(source, path.name)


def test_validates_and_normalizes_a_strict_geopackage(tmp_path):
	path = write_warnkarte(tmp_path / 'warnkarte_2024-06-25.gpkg')

	validated = validate_path(path)

	assert validated.source_date.isoformat() == '2024-06-25'
	assert validated.source_crs == 'EPSG:32632'
	assert validated.feature_count == 3
	assert [str(polygon.probability) for polygon in validated.polygons] == ['0.0', '0.6', '1.0']
	assert validated.warnings[0]['code'] == 'LAYER_DATE_MISMATCH'


@pytest.mark.parametrize(
	('filename', 'code'),
	[
		('warnkarte_2024-06-25.zip', 'INVALID_FILENAME'),
		('warnkarte_2024-06-25.geojson', 'INVALID_FILENAME'),
		('warnkarte.gpkg', 'INVALID_FILENAME'),
		('warnkarte_2024-02-31.gpkg', 'INVALID_FILENAME_DATE'),
	],
)
def test_rejects_non_gpkg_and_invalid_filename_dates(filename, code):
	with pytest.raises(WarnkarteValidationError) as error:
		validate_warnkarte_file(BytesIO(b'not a geopackage'), filename)

	assert error.value.code == code


def test_rejects_oversized_file_with_structured_413(monkeypatch):
	monkeypatch.setattr(warnkarte_module, 'MAX_FILE_SIZE_BYTES', 4)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_warnkarte_file(BytesIO(b'12345'), 'warnkarte_2024-06-25.gpkg')

	assert error.value.code == 'FILE_TOO_LARGE'
	assert error.value.status_code == 413
	assert error.value.details['max_bytes'] == 4


def test_rejects_excessive_feature_count_with_structured_413(tmp_path, monkeypatch):
	path = write_warnkarte(tmp_path / 'warnkarte_2024-06-25.gpkg')
	monkeypatch.setattr(warnkarte_module, 'MAX_FEATURE_COUNT', 2)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code == 'TOO_MANY_FEATURES'
	assert error.value.status_code == 413


def test_rejects_excessive_geometry_complexity_with_structured_413(tmp_path, monkeypatch):
	path = write_warnkarte(
		tmp_path / 'warnkarte_2024-06-25.gpkg',
		probabilities=(0.5,),
	)
	monkeypatch.setattr(warnkarte_module, 'MAX_VERTICES_PER_POLYGON', 4)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code == 'GEOMETRY_TOO_COMPLEX'
	assert error.value.status_code == 413


@pytest.mark.parametrize('crs', [None, 'EPSG:4326'])
def test_rejects_missing_or_wrong_crs(tmp_path, crs):
	path = write_warnkarte(tmp_path / 'warnkarte_2024-06-25.gpkg', crs=crs)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code == 'INVALID_CRS'
	assert error.value.details['expected'] == 'EPSG:32632'


def test_rejects_multiple_layers(tmp_path):
	path = write_warnkarte(tmp_path / 'warnkarte_2024-06-25.gpkg')
	write_warnkarte(path, layer='second_layer', probabilities=(0.2,))

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code == 'INVALID_LAYER_COUNT'


@pytest.mark.parametrize(
	'properties',
	[
		{},
		{'risk': 'float'},
		{'probability': 'float', 'model': 'str'},
	],
)
def test_rejects_missing_or_unexpected_user_attributes(tmp_path, properties):
	path = write_warnkarte(
		tmp_path / 'warnkarte_2024-06-25.gpkg',
		properties=properties,
		probabilities=(0.5,),
	)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code == 'INVALID_COLUMNS'


@pytest.mark.parametrize('probability', [None, -0.1, 1.1, 0.65])
def test_rejects_invalid_probabilities(tmp_path, probability):
	path = write_warnkarte(
		tmp_path / 'warnkarte_2024-06-25.gpkg',
		probabilities=(probability,),
	)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code in {'INVALID_PROBABILITY', 'INVALID_PROBABILITY_STEP'}


def test_rejects_non_numeric_probability_attribute(tmp_path):
	path = write_warnkarte(
		tmp_path / 'warnkarte_2024-06-25.gpkg',
		properties={'probability': 'str'},
		probabilities=('not-a-number',),
	)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code == 'INVALID_PROBABILITY_TYPE'


def test_rejects_invalid_polygon_geometry(tmp_path):
	bow_tie = Polygon(
		[
			(450000, 5360000),
			(450010, 5360010),
			(450010, 5360000),
			(450000, 5360010),
			(450000, 5360000),
		]
	)
	path = write_warnkarte(
		tmp_path / 'warnkarte_2024-06-25.gpkg',
		probabilities=(0.5,),
		geometries=(bow_tie,),
	)

	with pytest.raises(WarnkarteValidationError) as error:
		validate_path(path)

	assert error.value.code == 'INVALID_GEOMETRY'


def test_representative_supplier_geopackage_when_available():
	path = Path('.local/fixtures/warning_polygons_newSKs_trainAll_2024-06-25.gpkg')
	if not path.exists():
		pytest.skip('Representative supplier GeoPackage is not available in ignored local test space')

	validated = validate_path(path)

	assert validated.source_date.isoformat() == '2024-06-25'
	assert validated.source_crs == 'EPSG:32632'
	assert validated.feature_count == 99
	assert {str(polygon.probability) for polygon in validated.polygons} <= {f'{step / 10:.1f}' for step in range(11)}
