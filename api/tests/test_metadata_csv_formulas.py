"""METADATA.csv in a download bundle must not run user text as a spreadsheet formula."""

import io
import zipfile

import pandas as pd
import pytest

from api.src.download.downloads import _write_metadata_tables


pytestmark = pytest.mark.unit


def test_metadata_csv_neutralizes_formula_text_but_parquet_keeps_values():
	df = pd.DataFrame(
		{
			'authors': ['=HYPERLINK("http://example.org","x")', 'Ada Lovelace'],
			'additional_information': ['@SUM(A1)', '-flight two'],
			'longitude': [-8.5, 7.25],
		}
	)
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, 'w') as archive:
		_write_metadata_tables(archive, df, include_parquet=True)
	with zipfile.ZipFile(buffer) as archive:
		csv = pd.read_csv(io.BytesIO(archive.read('METADATA.csv')))
		parquet = pd.read_parquet(io.BytesIO(archive.read('METADATA.parquet')))

	assert csv['authors'].tolist() == ['\'=HYPERLINK("http://example.org","x")', 'Ada Lovelace']
	assert csv['additional_information'].tolist() == ["'@SUM(A1)", "'-flight two"]
	assert csv['longitude'].tolist() == [-8.5, 7.25]
	pd.testing.assert_frame_equal(parquet, df)
