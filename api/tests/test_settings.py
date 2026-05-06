from shared.settings import Settings


def make_settings(**overrides):
	defaults = {
		'SUPABASE_URL': 'http://example.supabase',
		'SUPABASE_KEY': 'example-key',
	}
	defaults.update(overrides)
	return Settings(**defaults)


def test_production_dependent_urls_follow_dev_mode():
	settings = make_settings(ENV='production', DEV_MODE=False)

	assert settings.API_ENDPOINT == 'https://data2.deadtrees.earth/api/v1/'
	assert settings.API_ENTPOINT_DATASETS == 'https://data2.deadtrees.earth/api/v1/datasets/chunk'
	assert settings.PREPACKAGED_DOWNLOAD_BASE_URL == 'https://data2.deadtrees.earth/prepackaged/v1'
	assert settings.PREPACKAGED_GRANTS_PER_USER_PER_DAY == 5
	assert settings.PREPACKAGED_GRANTS_GLOBAL_PER_DAY == 30


def test_explicit_prepackaged_download_base_url_is_preserved():
	settings = make_settings(
		DEV_MODE=False,
		PREPACKAGED_DOWNLOAD_BASE_URL='https://downloads.example/prepackaged/v1',
	)

	assert settings.PREPACKAGED_DOWNLOAD_BASE_URL == 'https://downloads.example/prepackaged/v1'
