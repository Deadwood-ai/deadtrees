from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
from pathlib import Path
import re
import tempfile
from typing import Any, BinaryIO

import fiona
from pyproj import CRS
from shapely.geometry import shape
from shapely.validation import explain_validity


EXPECTED_CRS = 'EPSG:32632'
EXPECTED_EPSG = 32632
PROBABILITY_STEP = Decimal('0.1')
PROBABILITY_TOLERANCE = Decimal('0.000001')
MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024
MAX_FEATURE_COUNT = 10_000
MAX_VERTICES_PER_POLYGON = 100_000
MAX_TOTAL_VERTICES = 1_000_000
FILENAME_DATE_PATTERN = re.compile(r'(?P<date>\d{4}-\d{2}-\d{2})\.gpkg$')
LAYER_DATE_PATTERN = re.compile(r'\d{4}-\d{2}-\d{2}')


class WarnkarteValidationError(ValueError):
	def __init__(
		self,
		code: str,
		message: str,
		*,
		details: dict[str, Any] | None = None,
		status_code: int = 400,
	):
		super().__init__(message)
		self.code = code
		self.message = message
		self.details = details or {}
		self.status_code = status_code

	def as_detail(self) -> dict[str, Any]:
		return {
			'code': self.code,
			'message': self.message,
			'details': self.details,
		}


@dataclass(frozen=True)
class ValidatedWarnkartePolygon:
	fid: int
	probability: Decimal
	wkb_hex: str

	def as_rpc_payload(self) -> dict[str, Any]:
		return {
			'fid': self.fid,
			'probability': format(self.probability, '.1f'),
			'wkb_hex': self.wkb_hex,
		}


@dataclass(frozen=True)
class ValidatedWarnkarte:
	source_filename: str
	checksum_sha256: str
	source_date: date
	source_layer: str
	source_crs: str
	polygons: tuple[ValidatedWarnkartePolygon, ...]
	warnings: tuple[dict[str, Any], ...]

	@property
	def feature_count(self) -> int:
		return len(self.polygons)

	def summary(self) -> dict[str, Any]:
		return {
			'source_filename': self.source_filename,
			'checksum_sha256': self.checksum_sha256,
			'authoritative_date': self.source_date.isoformat(),
			'layer': self.source_layer,
			'crs': self.source_crs,
			'feature_count': self.feature_count,
			'warnings': list(self.warnings),
		}


def parse_source_filename(filename: str | None) -> tuple[str, date]:
	source_filename = Path(filename or '').name
	match = FILENAME_DATE_PATTERN.search(source_filename)
	if not match:
		raise WarnkarteValidationError(
			'INVALID_FILENAME',
			'Der Dateiname muss direkt vor .gpkg ein gültiges Datum im Format JJJJ-MM-TT enthalten.',
			details={'expected': '*YYYY-MM-DD.gpkg', 'detected': source_filename or None},
		)

	try:
		source_date = date.fromisoformat(match.group('date'))
	except ValueError as error:
		raise WarnkarteValidationError(
			'INVALID_FILENAME_DATE',
			'Das Datum im Dateinamen ist kein gültiges Kalenderdatum.',
			details={'detected': match.group('date')},
		) from error

	return source_filename, source_date


def normalize_probability(value: Any, fid: int) -> Decimal:
	if value is None or isinstance(value, bool):
		raise WarnkarteValidationError(
			'INVALID_PROBABILITY',
			'Jedes Polygon benötigt einen Wahrscheinlichkeitswert.',
			details={'fid': fid, 'detected': value},
		)

	try:
		probability = Decimal(str(value))
	except (InvalidOperation, ValueError) as error:
		raise WarnkarteValidationError(
			'INVALID_PROBABILITY',
			'Die Wahrscheinlichkeit muss eine Zahl zwischen 0,0 und 1,0 sein.',
			details={'fid': fid, 'detected': str(value)},
		) from error

	if not probability.is_finite():
		raise WarnkarteValidationError(
			'INVALID_PROBABILITY',
			'Die Wahrscheinlichkeit muss eine endliche Zahl sein.',
			details={'fid': fid, 'detected': str(value)},
		)

	normalized = probability.quantize(PROBABILITY_STEP, rounding=ROUND_HALF_UP)
	if normalized < Decimal('0.0') or normalized > Decimal('1.0'):
		raise WarnkarteValidationError(
			'INVALID_PROBABILITY',
			'Die Wahrscheinlichkeit muss zwischen 0,0 und 1,0 liegen.',
			details={'fid': fid, 'detected': str(value)},
		)

	if abs(probability - normalized) > PROBABILITY_TOLERANCE:
		raise WarnkarteValidationError(
			'INVALID_PROBABILITY_STEP',
			'Die Wahrscheinlichkeit muss in Schritten von 0,1 angegeben sein.',
			details={'fid': fid, 'detected': str(value), 'step': '0.1'},
		)

	return normalized


def describe_crs(collection) -> tuple[CRS | None, str | None]:
	crs_input = collection.crs_wkt or collection.crs
	if not crs_input:
		return None, None

	try:
		crs = CRS.from_user_input(crs_input)
	except Exception:
		return None, str(crs_input)

	detected = crs.to_string()
	return crs, detected


def copy_and_hash(
	source: BinaryIO,
	target: BinaryIO,
	*,
	max_bytes: int = MAX_FILE_SIZE_BYTES,
) -> str:
	digest = hashlib.sha256()
	bytes_read = 0
	while chunk := source.read(1024 * 1024):
		bytes_read += len(chunk)
		if bytes_read > max_bytes:
			raise WarnkarteValidationError(
				'FILE_TOO_LARGE',
				'Das GeoPackage ist zu groß.',
				details={'max_bytes': max_bytes, 'detected_at_least_bytes': bytes_read},
				status_code=413,
			)
		digest.update(chunk)
		target.write(chunk)
	return digest.hexdigest()


def count_polygon_vertices(geometry) -> int:
	return len(geometry.exterior.coords) + sum(len(interior.coords) for interior in geometry.interiors)


def validate_warnkarte_file(file_object: BinaryIO, filename: str | None) -> ValidatedWarnkarte:
	source_filename, source_date = parse_source_filename(filename)

	try:
		file_object.seek(0)
	except (AttributeError, OSError):
		pass

	with tempfile.TemporaryDirectory(prefix='priwa-warnkarte-') as temporary_directory:
		temporary_path = Path(temporary_directory) / source_filename
		with temporary_path.open('wb') as target:
			checksum_sha256 = copy_and_hash(
				file_object,
				target,
				max_bytes=MAX_FILE_SIZE_BYTES,
			)

		try:
			layers = fiona.listlayers(temporary_path)
		except Exception as error:
			raise WarnkarteValidationError(
				'INVALID_GEOPACKAGE',
				'Die Datei ist kein lesbares GeoPackage.',
			) from error

		if len(layers) != 1:
			raise WarnkarteValidationError(
				'INVALID_LAYER_COUNT',
				'Das GeoPackage muss genau einen Layer enthalten.',
				details={'expected': 1, 'detected': len(layers)},
			)

		layer_name = layers[0]
		try:
			with fiona.open(temporary_path, layer=layer_name) as collection:
				if collection.driver != 'GPKG':
					raise WarnkarteValidationError(
						'INVALID_GEOPACKAGE',
						'Die Datei ist kein direktes GeoPackage.',
						details={'expected': 'GPKG', 'detected': collection.driver},
					)

				crs, detected_crs = describe_crs(collection)
				if crs is None or crs.to_epsg() != EXPECTED_EPSG:
					raise WarnkarteValidationError(
						'INVALID_CRS',
						'Das Koordinatenreferenzsystem muss eindeutig EPSG:32632 sein.',
						details={'expected': EXPECTED_CRS, 'detected': detected_crs},
					)

				geometry_type = collection.schema.get('geometry')
				if geometry_type != 'Polygon':
					raise WarnkarteValidationError(
						'INVALID_GEOMETRY_TYPE',
						'Der Layer darf ausschließlich Polygon-Geometrien enthalten.',
						details={'expected': 'Polygon', 'detected': geometry_type},
					)

				property_schema = collection.schema.get('properties', {})
				properties = list(property_schema.keys())
				if properties != ['probability']:
					raise WarnkarteValidationError(
						'INVALID_COLUMNS',
						'Der Layer muss genau ein Attribut mit dem Namen probability enthalten.',
						details={'expected': ['probability'], 'detected': properties},
					)
				probability_type = str(property_schema['probability']).split(':', 1)[0]
				if probability_type not in {'float', 'int', 'int64'}:
					raise WarnkarteValidationError(
						'INVALID_PROBABILITY_TYPE',
						'Das Attribut probability muss numerisch sein.',
						details={'expected': 'numeric', 'detected': probability_type},
					)

				polygons: list[ValidatedWarnkartePolygon] = []
				seen_fids: set[int] = set()
				total_vertices = 0
				for feature_index, feature in enumerate(collection, start=1):
					if feature_index > MAX_FEATURE_COUNT:
						raise WarnkarteValidationError(
							'TOO_MANY_FEATURES',
							'Das GeoPackage enthält zu viele Polygone.',
							details={'max_features': MAX_FEATURE_COUNT},
							status_code=413,
						)

					try:
						fid = int(feature.id)
					except (TypeError, ValueError) as error:
						raise WarnkarteValidationError(
							'INVALID_FID',
							'Jedes Polygon benötigt eine eindeutige intrinsische FID.',
							details={'detected': feature.id},
						) from error

					if fid in seen_fids:
						raise WarnkarteValidationError(
							'DUPLICATE_FID',
							'Die intrinsischen FIDs müssen eindeutig sein.',
							details={'fid': fid},
						)
					seen_fids.add(fid)

					if feature.geometry is None:
						raise WarnkarteValidationError(
							'INVALID_GEOMETRY',
							'Jedes Objekt benötigt eine nicht-leere gültige Polygon-Geometrie.',
							details={'fid': fid, 'reason': 'missing'},
						)

					geometry = shape(feature.geometry)
					if geometry.geom_type != 'Polygon' or geometry.is_empty or not geometry.is_valid:
						raise WarnkarteValidationError(
							'INVALID_GEOMETRY',
							'Jedes Objekt benötigt eine nicht-leere gültige Polygon-Geometrie.',
							details={
								'fid': fid,
								'type': geometry.geom_type,
								'reason': explain_validity(geometry),
							},
						)

					vertex_count = count_polygon_vertices(geometry)
					total_vertices += vertex_count
					if vertex_count > MAX_VERTICES_PER_POLYGON or total_vertices > MAX_TOTAL_VERTICES:
						raise WarnkarteValidationError(
							'GEOMETRY_TOO_COMPLEX',
							'Die Polygon-Geometrie ist zu komplex.',
							details={
								'fid': fid,
								'max_vertices_per_polygon': MAX_VERTICES_PER_POLYGON,
								'max_total_vertices': MAX_TOTAL_VERTICES,
							},
							status_code=413,
						)

					probability = normalize_probability(feature.properties.get('probability'), fid)
					polygons.append(
						ValidatedWarnkartePolygon(
							fid=fid,
							probability=probability,
							wkb_hex=geometry.wkb_hex,
						)
					)
		except WarnkarteValidationError:
			raise
		except Exception as error:
			raise WarnkarteValidationError(
				'INVALID_GEOPACKAGE',
				'Das GeoPackage konnte nicht vollständig gelesen werden.',
			) from error

	if not polygons:
		raise WarnkarteValidationError(
			'EMPTY_LAYER',
			'Der Warnkarten-Layer darf nicht leer sein.',
		)

	warnings: list[dict[str, Any]] = []
	layer_dates = sorted(set(LAYER_DATE_PATTERN.findall(layer_name)))
	if layer_dates and source_date.isoformat() not in layer_dates:
		warnings.append(
			{
				'code': 'LAYER_DATE_MISMATCH',
				'message': 'Ein Datum im Layernamen weicht vom maßgeblichen Dateinamen ab.',
				'details': {
					'authoritative_date': source_date.isoformat(),
					'layer_dates': layer_dates,
				},
			}
		)

	return ValidatedWarnkarte(
		source_filename=source_filename,
		checksum_sha256=checksum_sha256,
		source_date=source_date,
		source_layer=layer_name,
		source_crs=EXPECTED_CRS,
		polygons=tuple(polygons),
		warnings=tuple(warnings),
	)
