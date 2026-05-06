try:
	import utm
except ImportError:  # pragma: no cover - local CLI test env does not install processor extras
	utm = None


def get_utm_string_from_latlon(lat, lon):
	if utm:
		zone_number = utm.from_latlon(lat, lon)[2]
	else:
		zone_number = int((lon + 180.0) // 6.0) + 1
		zone_number = min(max(zone_number, 1), 60)

	utm_code = 32600 + zone_number
	if lat < 0:
		utm_code += 100

	return f'EPSG:{utm_code}'
