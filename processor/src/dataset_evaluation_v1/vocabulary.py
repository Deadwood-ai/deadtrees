"""Fixed answer vocabulary of the dataset evaluation, shared by the models, the rules,
the labeling page and the audit page. Changing a list is a new check version."""

CHECK_KEY = 'dataset_evaluation'
LAYER = 'image'

# The model's word for each verdict of audit.verdict.
VERDICTS = {'keep': 'ok', 'fix': 'minor', 'exclude': 'major', 'unsure': 'unsure'}

# Exclude reasons (the audit's fixed list). Duplicates, georeferencing and season are
# decided by their own checks, so the models never name them.
REASONS = (
	'blurry',
	'duplicate',
	'no_trees',
	'wrong_georeferencing',
	'artifacts',
	'season',
	'not_rgb',
	'broken_ortho',
	'too_dark',
	'other',
)
MODEL_REASONS = ('blurry', 'no_trees', 'artifacts', 'not_rgb', 'broken_ortho', 'too_dark', 'other')

# Flags with a 0-100 likelihood; every key names a problem.
EXCLUDE_FLAGS = ('blurry', 'not_rgb', 'no_trees', 'broken_ortho', 'too_dark', 'artifacts')
FIX_FLAGS = ('cog_issue', 'thumbnail_issue', 'reprocess')
FLAGS = EXCLUDE_FLAGS + FIX_FLAGS

SHARPNESS = ('sharp', 'slightly_soft', 'blurry')
LIGHTING = ('good', 'dark', 'bright', 'uneven', 'hazy')
# A hint only: the season itself is the acquisition date and phenology checks' call.
LEAF_STATES = ('leaf_on', 'leaf_off', 'mixed', 'no_trees', 'unclear')
IMAGE_TYPES = ('rgb', 'false_colour', 'grayscale', 'thermal', 'other')
# What the flight shows as a whole.
SCENES = (
	'forest_interior',
	'forest_edge',
	'disturbed_forest',
	'plantation',
	'woodland_savanna',
	'agricultural_landscape',
	'urban_or_park',
	'water_or_coast',
	'mountain_or_rock',
	'other',
)
# The dominant land cover of the image.
LAND_COVERS = (
	'closed_forest',
	'open_forest',
	'shrubland',
	'grassland',
	'cropland',
	'built_up',
	'water',
	'bare',
	'snow_or_ice',
	'wetland',
	'other',
)

CATEGORIES = {
	'sharpness': SHARPNESS,
	'lighting': LIGHTING,
	'leaf_state': LEAF_STATES,
	'image_type': IMAGE_TYPES,
	'scene': SCENES,
	'land_cover': LAND_COVERS,
}
