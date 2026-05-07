import pytest

from shared.db import login, use_client
from shared.models import DatasetAccessEnum, LicenseEnum, PlatformEnum
from shared.settings import settings


@pytest.fixture(scope='function')
def audit_privileged_user(test_user):
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	privileged_user_id = None
	previous_privilege = None

	try:
		with use_client(processor_token) as client:
			existing = client.table('privileged_users').select('*').eq('user_id', test_user).limit(1).execute()

			if existing.data:
				previous_privilege = existing.data[0]
				client.table('privileged_users').update(
					{
						'can_upload_private': previous_privilege.get('can_upload_private', False),
						'can_view_all_private': previous_privilege.get('can_view_all_private', False),
						'can_audit': True,
					}
				).eq('id', previous_privilege['id']).execute()
			else:
				response = client.table('privileged_users').insert(
					{
						'user_id': test_user,
						'can_upload_private': False,
						'can_view_all_private': False,
						'can_audit': True,
					}
				).execute()
				privileged_user_id = response.data[0]['id']

		yield test_user

	finally:
		with use_client(processor_token) as client:
			if previous_privilege:
				client.table('privileged_users').update(
					{
						'can_upload_private': previous_privilege.get('can_upload_private', False),
						'can_view_all_private': previous_privilege.get('can_view_all_private', False),
						'can_audit': previous_privilege.get('can_audit', False),
					}
				).eq('id', previous_privilege['id']).execute()
			elif privileged_user_id:
				client.table('privileged_users').delete().eq('id', privileged_user_id).execute()


@pytest.fixture(scope='function')
def flagged_dataset(test_user2):
	reporter_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)
	dataset_id = None
	flag_id = None

	try:
		with use_client(reporter_token) as client:
			dataset_response = client.table(settings.datasets_table).insert(
				{
					'file_name': 'auditor-flag-review-contract.tif',
					'user_id': test_user2,
					'license': LicenseEnum.cc_by.value,
					'platform': PlatformEnum.drone.value,
					'authors': ['Flag Review Contract Reporter'],
					'data_access': DatasetAccessEnum.public.value,
					'aquisition_year': 2024,
					'aquisition_month': 5,
					'aquisition_day': 6,
				}
			).execute()
			dataset_id = dataset_response.data[0]['id']

			flag_response = client.table('dataset_flags').insert(
				{
					'dataset_id': dataset_id,
					'created_by': test_user2,
					'is_ortho_mosaic_issue': True,
					'is_prediction_issue': False,
					'description': 'Local contract smoke issue',
					'status': 'open',
				}
			).execute()
			flag_id = flag_response.data[0]['id']

		yield {'dataset_id': dataset_id, 'flag_id': flag_id}

	finally:
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
		with use_client(processor_token) as client:
			if flag_id:
				client.table('dataset_flag_status_history').delete().eq('flag_id', flag_id).execute()
				client.table('dataset_flags').delete().eq('id', flag_id).execute()
			if dataset_id:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.fixture(scope='function')
def non_audit_user(test_user2):
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	created_privilege_id = None
	previous_privileges = []

	try:
		with use_client(processor_token) as client:
			existing = client.table('privileged_users').select('*').eq('user_id', test_user2).execute()
			previous_privileges = existing.data or []

			if previous_privileges:
				client.table('privileged_users').update(
					{
						'can_upload_private': False,
						'can_view_all_private': False,
						'can_audit': False,
					}
				).eq('user_id', test_user2).execute()
			else:
				response = client.table('privileged_users').insert(
					{
						'user_id': test_user2,
						'can_upload_private': False,
						'can_view_all_private': False,
						'can_audit': False,
					}
				).execute()
				created_privilege_id = response.data[0]['id']

		yield test_user2

	finally:
		with use_client(processor_token) as client:
			if previous_privileges:
				for privilege in previous_privileges:
					client.table('privileged_users').update(
						{
							'can_upload_private': privilege.get('can_upload_private', False),
							'can_view_all_private': privilege.get('can_view_all_private', False),
							'can_audit': privilege.get('can_audit', False),
						}
					).eq('id', privilege['id']).execute()
			elif created_privilege_id:
				client.table('privileged_users').delete().eq('id', created_privilege_id).execute()


def test_auditor_flag_review_rpc_requires_auditor_and_records_history(
	audit_privileged_user,
	auth_token,
	flagged_dataset,
	non_audit_user,
	test_user,
):
	reporter_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(reporter_token) as reporter_client:
		with pytest.raises(Exception, match='not_authorized'):
			reporter_client.rpc(
				'update_flag_status',
				{
					'p_flag_id': flagged_dataset['flag_id'],
					'p_new_status': 'acknowledged',
					'p_note': 'Reporter cannot acknowledge audit flags',
				},
			).execute()

	with use_client(auth_token) as auditor_client:
		auditor_client.rpc(
			'update_flag_status',
			{
				'p_flag_id': flagged_dataset['flag_id'],
				'p_new_status': 'acknowledged',
				'p_note': 'Auditor acknowledged local smoke issue',
			},
		).execute()

		flag_response = (
			auditor_client.table('dataset_flags')
			.select('status,auditor_comment,resolved_by')
			.eq('id', flagged_dataset['flag_id'])
			.single()
			.execute()
		)
		assert flag_response.data == {
			'status': 'acknowledged',
			'auditor_comment': 'Auditor acknowledged local smoke issue',
			'resolved_by': None,
		}

		auditor_client.rpc(
			'update_flag_status',
			{
				'p_flag_id': flagged_dataset['flag_id'],
				'p_new_status': 'resolved',
				'p_note': 'Auditor resolved local smoke issue',
			},
		).execute()

		resolved_response = (
			auditor_client.table('dataset_flags')
			.select('status,auditor_comment,resolved_by')
			.eq('id', flagged_dataset['flag_id'])
			.single()
			.execute()
		)
		assert resolved_response.data == {
			'status': 'resolved',
			'auditor_comment': 'Auditor resolved local smoke issue',
			'resolved_by': test_user,
		}

		history_response = (
			auditor_client.table('dataset_flag_status_history')
			.select('old_status,new_status,changed_by,note')
			.eq('flag_id', flagged_dataset['flag_id'])
			.order('changed_at')
			.execute()
		)
		assert history_response.data == [
			{
				'old_status': 'open',
				'new_status': 'acknowledged',
				'changed_by': test_user,
				'note': 'Auditor acknowledged local smoke issue',
			},
			{
				'old_status': 'acknowledged',
				'new_status': 'resolved',
				'changed_by': test_user,
				'note': 'Auditor resolved local smoke issue',
			},
		]
