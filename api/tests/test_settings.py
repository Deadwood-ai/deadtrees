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
	assert settings.PREPACKAGED_S3_REGION == 'fr1-ec82'
	assert settings.PREPACKAGED_S3_BUCKET == 'frct-deadtrees-products'
	assert settings.PREPACKAGED_SIGNED_URL_TTL_SECONDS == 604800


def test_explicit_prepackaged_download_base_url_is_preserved():
	settings = make_settings(
		DEV_MODE=False,
		PREPACKAGED_DOWNLOAD_BASE_URL='https://downloads.example/prepackaged/v1',
	)

	assert settings.PREPACKAGED_DOWNLOAD_BASE_URL == 'https://downloads.example/prepackaged/v1'


def test_explicit_prepackaged_s3_settings_are_preserved():
	settings = make_settings(
		PREPACKAGED_S3_ENDPOINT_URL='https://s3.example',
		PREPACKAGED_S3_REGION='example-region',
		PREPACKAGED_S3_BUCKET='example-bucket',
		PREPACKAGED_API_READ_S3_ACCESS_KEY='read-key',
		PREPACKAGED_API_READ_S3_SECRET_KEY='read-secret',
		PREPACKAGED_SIGNED_URL_TTL_SECONDS=120,
	)

	assert settings.PREPACKAGED_S3_ENDPOINT_URL == 'https://s3.example'
	assert settings.PREPACKAGED_S3_REGION == 'example-region'
	assert settings.PREPACKAGED_S3_BUCKET == 'example-bucket'
	assert settings.PREPACKAGED_API_READ_S3_ACCESS_KEY == 'read-key'
	assert settings.PREPACKAGED_API_READ_S3_SECRET_KEY == 'read-secret'
	assert settings.PREPACKAGED_SIGNED_URL_TTL_SECONDS == 120
