"""
RTK (Real-Time Kinematic) positioning utilities for drone image processing.

This module provides functions to detect and parse RTK positioning files that
accompany drone images for high-precision GPS positioning.
"""

from pathlib import Path
from typing import List, Dict, Any, Optional
import re

from shared.logging import LogCategory, LogContext, UnifiedLogger, SupabaseHandler

# Create logger instance
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())

# RTK file extensions that indicate high-precision GPS data
RTK_EXTENSIONS = {
	'.RTK',  # RTK correction data
	'.MRK',  # Timestamp/marker files
	'.RTL',  # RTK log files
	'.RTB',  # RTK base station data
	'.RPOS',  # RTK position files
	'.RTS',  # RTK solution files
	'.IMU',  # Inertial Measurement Unit data
}


def detect_rtk_files(zip_files: List[str]) -> Dict[str, Any]:
	"""
	Detect RTK positioning files in a ZIP archive file list.

	Args:
	    zip_files: List of file paths/names from ZIP archive

	Returns:
	    Dictionary containing:
	    - 'has_rtk': bool indicating if RTK files were found
	    - 'rtk_files': list of RTK file paths
	    - 'rtk_types': dict mapping file types to file lists
	    - 'precision_estimate': estimated precision level if determinable
	"""
	rtk_info = {'has_rtk': False, 'rtk_files': [], 'rtk_types': {}, 'precision_estimate': None}

	# Initialize type tracking
	for ext in RTK_EXTENSIONS:
		rtk_info['rtk_types'][ext.lower()] = []

	# Check each file for RTK extensions
	for file_path in zip_files:
		file_path_obj = Path(file_path)
		file_ext = file_path_obj.suffix.upper()

		if file_ext in RTK_EXTENSIONS:
			rtk_info['has_rtk'] = True
			rtk_info['rtk_files'].append(file_path)
			rtk_info['rtk_types'][file_ext.lower()].append(file_path)

	if rtk_info['has_rtk']:
		# Estimate precision based on file types present
		if rtk_info['rtk_types'].get('.mrk') or rtk_info['rtk_types'].get('.rtk'):
			# .MRK and .RTK files typically indicate centimeter-level precision
			rtk_info['precision_estimate'] = 'centimeter'
		elif rtk_info['rtk_types'].get('.rpos') or rtk_info['rtk_types'].get('.rts'):
			# Position and solution files indicate high precision
			rtk_info['precision_estimate'] = 'sub_meter'
		else:
			# Other RTK files present but precision unknown
			rtk_info['precision_estimate'] = 'enhanced'

		logger.info(
			f'Detected {len(rtk_info["rtk_files"])} RTK files with {rtk_info["precision_estimate"]} precision',
			LogContext(category=LogCategory.UPLOAD, extra={'rtk_files': rtk_info['rtk_files']}),
		)
	else:
		logger.debug('No RTK files detected in ZIP archive', LogContext(category=LogCategory.UPLOAD))

	return rtk_info


def parse_rtk_timestamp_file(mrk_path: Path) -> Dict[str, Any]:
	"""
	Parse RTK timestamp/marker file (.MRK) to extract precision values and quality indicators.

	.MRK files typically contain:
	- GPS timestamps synchronized with image capture
	- Position accuracy estimates
	- Signal quality indicators
	- RTK solution status

	Args:
	    mrk_path: Path to the .MRK file

	Returns:
	    Dictionary containing:
	    - 'timestamps': list of GPS timestamps
	    - 'accuracy_horizontal': estimated horizontal accuracy (meters)
	    - 'accuracy_vertical': estimated vertical accuracy (meters)
	    - 'solution_quality': RTK solution quality indicator
	    - 'satellite_count': number of satellites used
	    - 'records_count': total number of timestamp records
	"""
	rtk_data = {
		'timestamps': [],
		'accuracy_horizontal': None,
		'accuracy_vertical': None,
		'solution_quality': None,
		'satellite_count': None,
		'records_count': 0,
	}

	if not mrk_path.exists():
		logger.warning(f'RTK timestamp file not found: {mrk_path}', LogContext(category=LogCategory.UPLOAD))
		return rtk_data

	try:
		with open(mrk_path, 'r', encoding='utf-8', errors='ignore') as f:
			content = f.read()

		# Parse line by line to extract RTK data
		lines = content.split('\n')
		rtk_data['records_count'] = len([line for line in lines if line.strip()])

		for line in lines:
			line = line.strip()
			if not line:
				continue

			# Look for timestamp patterns (various formats possible)
			# Common formats: YYYY-MM-DD HH:MM:SS, GPS week/seconds, etc.
			timestamp_patterns = [
				r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})',  # YYYY-MM-DD HH:MM:SS
				r'(\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2})',  # MM/DD/YYYY HH:MM:SS
				r'(\d{10}\.\d+)',  # GPS seconds timestamp
			]

			for pattern in timestamp_patterns:
				matches = re.findall(pattern, line)
				rtk_data['timestamps'].extend(matches)

			# Look for accuracy indicators (various field names possible)
			accuracy_patterns = [
				(r'(?:HRMS|horizontal.*accuracy|h.*acc)[\s:=]+(\d+\.?\d*)', 'accuracy_horizontal'),
				(r'(?:VRMS|vertical.*accuracy|v.*acc)[\s:=]+(\d+\.?\d*)', 'accuracy_vertical'),
				(r'(?:satellites|sats|sv)[\s:=]+(\d+)', 'satellite_count'),
				(r'(?:quality|fix.*type|solution)[\s:=]+(\w+)', 'solution_quality'),
			]

			for pattern, field in accuracy_patterns:
				matches = re.findall(pattern, line, re.IGNORECASE)
				if matches and rtk_data[field] is None:
					try:
						if field in ['accuracy_horizontal', 'accuracy_vertical']:
							rtk_data[field] = float(matches[0])
						elif field == 'satellite_count':
							rtk_data[field] = int(matches[0])
						else:
							rtk_data[field] = matches[0]
					except (ValueError, TypeError):
						continue

		# Set defaults based on typical RTK performance if not found in file
		if rtk_data['accuracy_horizontal'] is None:
			# Typical RTK horizontal accuracy is 1-3cm
			rtk_data['accuracy_horizontal'] = 0.02  # 2cm default

		if rtk_data['accuracy_vertical'] is None:
			# Typical RTK vertical accuracy is 2-5cm
			rtk_data['accuracy_vertical'] = 0.03  # 3cm default

		if rtk_data['solution_quality'] is None:
			# Assume fixed RTK solution if file is present
			rtk_data['solution_quality'] = 'RTK_FIXED'

		logger.info(
			f'Parsed RTK timestamp file: {rtk_data["records_count"]} records, '
			f'H_acc: {rtk_data["accuracy_horizontal"]}m, V_acc: {rtk_data["accuracy_vertical"]}m',
			context=LogContext.PROCESSING,
			category=LogCategory.INFO,
		)

	except Exception as e:
		logger.error(
			f'Failed to parse RTK timestamp file {mrk_path}: {str(e)}',
			context=LogContext.PROCESSING,
			category=LogCategory.ERROR,
		)
		# Return defaults for RTK presence
		rtk_data.update(
			{
				'accuracy_horizontal': 0.02,  # 2cm
				'accuracy_vertical': 0.03,  # 3cm
				'solution_quality': 'RTK_ASSUMED',
			}
		)

	return rtk_data


def get_odm_rtk_parameters(rtk_info: Dict[str, Any], mrk_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
	"""
	Generate ODM command parameters based on detected RTK data.

	Args:
	    rtk_info: RTK detection results from detect_rtk_files()
	    mrk_data: Optional parsed MRK file data from parse_rtk_timestamp_file()

	Returns:
	    Dictionary containing ODM parameters:
	    - 'use_rtk': bool indicating if RTK parameters should be used
	    - 'force_gps': bool for --force-gps flag
	    - 'gps_accuracy': float for --gps-accuracy parameter (meters)
	    - 'additional_params': list of additional ODM parameters
	"""
	odm_params = {'use_rtk': False, 'force_gps': False, 'gps_accuracy': None, 'additional_params': []}

	if not rtk_info.get('has_rtk'):
		return odm_params

	odm_params['use_rtk'] = True
	odm_params['force_gps'] = True

	# Determine GPS accuracy based on RTK data
	if mrk_data and mrk_data.get('accuracy_horizontal'):
		# Use horizontal accuracy from MRK file, converted to meters
		accuracy = mrk_data['accuracy_horizontal']
		if accuracy < 1.0:  # Already in meters
			odm_params['gps_accuracy'] = accuracy
		else:  # Might be in centimeters or millimeters
			odm_params['gps_accuracy'] = accuracy / 100.0  # Assume cm, convert to m
	else:
		# Use defaults based on precision estimate
		precision = rtk_info.get('precision_estimate', 'enhanced')
		if precision == 'centimeter':
			odm_params['gps_accuracy'] = 0.02  # 2cm
		elif precision == 'sub_meter':
			odm_params['gps_accuracy'] = 0.1  # 10cm
		else:
			odm_params['gps_accuracy'] = 0.5  # 50cm for enhanced GPS

	# Ensure accuracy is within reasonable ODM range (1cm to 10m)
	if odm_params['gps_accuracy']:
		odm_params['gps_accuracy'] = max(0.01, min(10.0, odm_params['gps_accuracy']))

	logger.info(
		f'Generated ODM RTK parameters: force_gps={odm_params["force_gps"]}, accuracy={odm_params["gps_accuracy"]}m',
		context=LogContext.PROCESSING,
		category=LogCategory.INFO,
	)

	return odm_params
