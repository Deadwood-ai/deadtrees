from setuptools import setup, find_packages
import sys
from pathlib import Path

# Add the root directory to Python path for shared module access
root_dir = Path(__file__).parent.parent
sys.path.append(str(root_dir))

setup(
	name='deadtrees-cli',
	version='0.1.0',
	# shared lives outside this directory; list its subpackages explicitly so a
	# regular (non-editable) install also ships the modules dev.py imports.
	packages=find_packages() + ['shared', 'shared.notifications', 'shared.testing'],
	package_dir={'shared': '../shared'},
	install_requires=[
		'fire>=0.5.0',
		'httpx>=0.24.0',
		'tqdm>=4.65.0',
		'python-dotenv>=1.0.0',
		'pydantic>=2.0.0',
		'shapely>=2.0.0',
		'geopandas>=0.13.0',
		# Same compatibility envelope as api/ and processor/requirements.txt:
		# NumPy 2.5 breaks Rasterio 1.5 reads.
		'numpy>=2,<2.5',
		'rasterio>=1.5,<1.6',
		'pydantic-geojson==0.3.2',
		'supabase>=1.0.3',
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
