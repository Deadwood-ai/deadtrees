from setuptools import setup, find_packages
import sys
from pathlib import Path

# Add the root directory to Python path for shared module access
root_dir = Path(__file__).parent.parent
sys.path.append(str(root_dir))

setup(
	name='deadtrees-cli',
	version='0.1.0',
	packages=find_packages() + ['shared'],
	package_dir={'shared': '../shared'},
	install_requires=[
		'fire>=0.5.0',
		'httpx>=0.24.0',
		'tqdm>=4.65.0',
		'python-dotenv>=1.0.0',
		'pydantic>=2.0.0',
		'shapely>=2.0.0',
		'geopandas>=0.13.0',
		'rasterio>=1.4.2',
		'pydantic-geojson==0.2.0',
		'supabase>=1.0.3',
		'logfire>=0.8.0',
		'pydantic-partial>=0.3.1',
		'pydantic-settings>=2.0.0',
		'fiona>=1.9.0',
	],
	extras_require={
		'test': [
			'pytest>=7.0.0',
			'debugpy>=1.8.0',
		]
	},
	entry_points={
		'console_scripts': [
			'deadtrees=deadtrees_cli.cli:main',
		],
	},
)
