from processor.src.utils.crs import get_utm_string_from_latlon


def test_get_utm_string_from_latlon_uses_northern_epsg_codes():
	assert get_utm_string_from_latlon(42.28, 18.86) == 'EPSG:32634'


def test_get_utm_string_from_latlon_uses_southern_epsg_codes():
	assert get_utm_string_from_latlon(-32.87, 24.81) == 'EPSG:32735'
