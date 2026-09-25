"""Audit lease contracts on isolated PostgreSQL: claim, renew, expiry, release and save guard."""
import json
import threading
import time
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings


@pytest.fixture
def lease_db():
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}, 'Local database required'
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as db:
		try:
			yield db
		finally:
			db.rollback()


def create_user(db, can_audit):
	user = uuid.uuid4()
	db.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, f'{user}@example.invalid'))
	if can_audit:
		db.execute('INSERT INTO public.privileged_users(user_id,can_audit) VALUES (%s,true)', (user,))
	return user


def create_dataset(db, owner, legacy_in_audit=False):
	dataset = db.execute(
		"INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) VALUES (%s,'lease.tif','CC BY','drone','public') RETURNING id",
		(owner,),
	).fetchone()[0]
	db.execute('INSERT INTO public.v2_statuses(dataset_id,is_in_audit) VALUES (%s,%s)', (dataset, legacy_in_audit))
	return dataset


def act_as(db, user, lease=None, email=None):
	"""Act as a signed-in user; ``lease`` is the audit page sending the x-audit-lease header."""
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE authenticated')
	claims = {'sub': str(user), 'role': 'authenticated', **({'email': email} if email else {})}
	db.execute("SELECT set_config('request.jwt.claims',%s,true)", (json.dumps(claims),))
	headers = {'x-audit-lease': str(lease)} if lease else {}
	db.execute("SELECT set_config('request.headers',%s,true)", (json.dumps(headers),))


def as_admin(db):
	"""Service-role maintenance: no signed-in user and no audit page."""
	db.execute('RESET ROLE')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
	db.execute("SELECT set_config('request.headers','{}',true)")


def claim(db, dataset, lease, take_over=False):
	return db.execute('SELECT public.claim_dataset_audit_lock(%s,%s,%s)', (dataset, lease, take_over)).fetchone()[0]


def release(db, dataset, lease):
	db.execute('SELECT public.release_dataset_audit_lock(%s,%s)', (dataset, lease))


def lock_row(db, dataset):
	as_admin(db)
	return db.execute(
		'SELECT holder_id,lease_id,acquired_at,expires_at > now() FROM public.dataset_audit_locks WHERE dataset_id=%s',
		(dataset,),
	).fetchone()


def expire_lease(db, dataset):
	as_admin(db)
	db.execute("UPDATE public.dataset_audit_locks SET expires_at=now()-interval '1 second' WHERE dataset_id=%s", (dataset,))


def test_live_lease_is_exclusive_and_renewable_by_its_holder(lease_db):
	db = lease_db
	owner, first, second = create_user(db, False), create_user(db, True), create_user(db, True)
	dataset = create_dataset(db, owner)
	first_page, second_page = uuid.uuid4(), uuid.uuid4()

	act_as(db, first)
	assert claim(db, dataset, first_page)['acquired'] is True
	holder, lease, acquired_at, live = lock_row(db, dataset)
	assert (holder, lease, live) == (first, first_page, True)

	act_as(db, second)
	denied = claim(db, dataset, second_page)
	assert denied['acquired'] is False
	assert denied['holder_email'] == f'{first}@example.invalid'
	assert 0 < denied['retry_after_seconds'] <= 600
	assert lock_row(db, dataset)[0] == first

	# The page that holds the lease renews it.
	act_as(db, first)
	assert claim(db, dataset, first_page)['acquired'] is True
	assert lock_row(db, dataset)[:3] == (first, first_page, acquired_at)


def test_live_lease_belongs_to_one_page_until_its_holder_takes_over(lease_db):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	dataset = create_dataset(db, owner)
	first_page, second_page = uuid.uuid4(), uuid.uuid4()
	act_as(db, auditor)
	claim(db, dataset, first_page)

	# A second tab (or a reload after a crash) of the same auditor does not displace the page.
	denied = claim(db, dataset, second_page)
	assert denied['acquired'] is False
	assert denied['held_by_you'] is True
	assert lock_row(db, dataset)[1] == first_page

	# An explicit takeover moves the lease; the old page can no longer renew it.
	act_as(db, auditor)
	assert claim(db, dataset, second_page, take_over=True)['acquired'] is True
	assert lock_row(db, dataset)[1] == second_page
	act_as(db, auditor)
	assert claim(db, dataset, first_page)['acquired'] is False

	# After a clean release (normal reload), a new page claims without a takeover.
	act_as(db, auditor)
	release(db, dataset, second_page)
	assert claim(db, dataset, uuid.uuid4())['acquired'] is True


def test_takeover_is_limited_to_the_holder(lease_db):
	db = lease_db
	owner, first, second = create_user(db, False), create_user(db, True), create_user(db, True)
	dataset = create_dataset(db, owner)
	first_page = uuid.uuid4()
	act_as(db, first)
	claim(db, dataset, first_page)
	act_as(db, second)
	assert claim(db, dataset, uuid.uuid4(), take_over=True)['held_by_you'] is False
	assert lock_row(db, dataset)[:2] == (first, first_page)


def test_abandoned_lease_becomes_available_after_expiry(lease_db):
	db = lease_db
	owner, first, second = create_user(db, False), create_user(db, True), create_user(db, True)
	dataset = create_dataset(db, owner)
	act_as(db, first)
	claim(db, dataset, uuid.uuid4())
	expire_lease(db, dataset)

	act_as(db, second)
	second_page = uuid.uuid4()
	assert claim(db, dataset, second_page)['acquired'] is True
	holder, lease, _, live = lock_row(db, dataset)
	assert (holder, lease, live) == (second, second_page, True)

	# The first page wakes up after expiry: it must not reclaim the new holder's lease.
	act_as(db, first)
	assert claim(db, dataset, uuid.uuid4())['acquired'] is False
	assert lock_row(db, dataset)[0] == second


def test_release_only_removes_the_callers_own_page_lease(lease_db):
	db = lease_db
	owner, first, second = create_user(db, False), create_user(db, True), create_user(db, True)
	dataset = create_dataset(db, owner)
	first_page = uuid.uuid4()
	act_as(db, first)
	claim(db, dataset, first_page)

	act_as(db, second)
	release(db, dataset, first_page)
	assert lock_row(db, dataset)[0] == first

	act_as(db, first)
	release(db, dataset, uuid.uuid4())
	assert lock_row(db, dataset)[0] == first

	act_as(db, first)
	release(db, dataset, first_page)
	assert lock_row(db, dataset) is None


def test_only_auditors_can_claim_and_nobody_writes_the_table_directly(lease_db):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	dataset = create_dataset(db, owner)

	def expect_denied(user, statement, params):
		if user is None:
			as_admin(db)
			db.execute('SET LOCAL ROLE anon')
		else:
			act_as(db, user)
		db.execute('SAVEPOINT denied')
		with pytest.raises(psycopg.errors.InsufficientPrivilege):
			db.execute(statement, params)
		db.execute('ROLLBACK TO SAVEPOINT denied')

	claim_sql = 'SELECT public.claim_dataset_audit_lock(%s,%s)'
	expect_denied(owner, claim_sql, (dataset, uuid.uuid4()))
	expect_denied(None, claim_sql, (dataset, uuid.uuid4()))
	expect_denied(
		auditor,
		'INSERT INTO public.dataset_audit_locks(dataset_id,holder_id,lease_id,expires_at) VALUES (%s,%s,%s,now())',
		(dataset, auditor, uuid.uuid4()),
	)
	expect_denied(auditor, 'SELECT * FROM public.dataset_audit_locks', ())
	assert lock_row(db, dataset) is None


def expect_write_rejected(db, statement, params):
	db.execute('SAVEPOINT rejected_write')
	with pytest.raises(psycopg.errors.ObjectInUse):
		db.execute(statement, params)
	db.execute('ROLLBACK TO SAVEPOINT rejected_write')


def test_only_the_lease_page_can_write_the_audit(lease_db):
	db = lease_db
	owner, first, second = create_user(db, False), create_user(db, True), create_user(db, True)
	dataset = create_dataset(db, owner)
	first_page, other_tab = uuid.uuid4(), uuid.uuid4()
	act_as(db, first)
	claim(db, dataset, first_page)
	act_as(db, first, lease=first_page)
	db.execute("INSERT INTO public.dataset_audit(dataset_id,audited_by,notes) VALUES (%s,%s,'first saved')", (dataset, first))

	update = "UPDATE public.dataset_audit SET notes='overwritten' WHERE dataset_id=%s"
	act_as(db, second, lease=first_page)
	expect_write_rejected(db, update, (dataset,))
	act_as(db, first)
	expect_write_rejected(db, update, (dataset,))
	act_as(db, first, lease=other_tab)
	expect_write_rejected(db, update, (dataset,))

	# The lease page saves and marks reviewed.
	act_as(db, first, lease=first_page)
	db.execute('UPDATE public.dataset_audit SET reviewed_at=now(),reviewed_by=%s WHERE dataset_id=%s', (first, dataset))

	# After a takeover by the holder's new page, the old page is stale.
	act_as(db, first)
	claim(db, dataset, other_tab, take_over=True)
	act_as(db, first, lease=first_page)
	expect_write_rejected(db, update, (dataset,))

	# Once the lease expires unclaimed, saving is no longer blocked.
	expire_lease(db, dataset)
	act_as(db, second)
	db.execute("UPDATE public.dataset_audit SET notes='second saved' WHERE dataset_id=%s", (dataset,))
	as_admin(db)
	assert db.execute('SELECT notes FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 'second saved'


GEOMETRY = json.dumps({'type': 'MultiPolygon', 'coordinates': [[[[13.4, 52.5], [13.4, 52.6], [13.5, 52.6], [13.4, 52.5]]]]})
# shared.models.aoi_insert_payload omits `source`; the processor and owner label uploads send this shape.
INSERT_AOI_WITHOUT_SOURCE = (
	'INSERT INTO public.v2_aois(dataset_id,user_id,geometry,is_whole_image) VALUES (%s,%s,%s::jsonb,false) RETURNING id,source'
)
INSERT_MANUAL_AOI = (
	"INSERT INTO public.v2_aois(dataset_id,user_id,geometry,is_whole_image,source) VALUES (%s,%s,%s::jsonb,false,'manual') RETURNING id"
)


def processor_user(db, can_audit):
	user = db.execute("SELECT id FROM auth.users WHERE email='processor@deadtrees.earth'").fetchone()
	user = user[0] if user else db.execute(
		"INSERT INTO auth.users(id,email) VALUES (%s,'processor@deadtrees.earth') RETURNING id", (uuid.uuid4(),)
	).fetchone()[0]
	db.execute('DELETE FROM public.privileged_users WHERE user_id=%s', (user,))
	if can_audit:
		# The guard must not depend on the processor lacking audit rights.
		db.execute('INSERT INTO public.privileged_users(user_id,can_audit) VALUES (%s,true)', (user,))
	return user


def test_stale_auditor_page_cannot_write_or_delete_a_manual_aoi(lease_db):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	dataset = create_dataset(db, owner)
	page, stale_page = uuid.uuid4(), uuid.uuid4()
	act_as(db, auditor)
	claim(db, dataset, page)

	act_as(db, auditor, lease=stale_page)
	expect_write_rejected(db, INSERT_MANUAL_AOI, (dataset, auditor, GEOMETRY))
	# Omitting the header or the source does not bypass the lease.
	act_as(db, auditor)
	expect_write_rejected(db, INSERT_AOI_WITHOUT_SOURCE, (dataset, auditor, GEOMETRY))

	act_as(db, auditor, lease=page)
	aoi = db.execute(INSERT_MANUAL_AOI, (dataset, auditor, GEOMETRY)).fetchone()[0]

	delete = 'DELETE FROM public.v2_aois WHERE id=%s'
	act_as(db, auditor, lease=stale_page)
	expect_write_rejected(db, delete, (aoi,))
	act_as(db, auditor)
	expect_write_rejected(db, delete, (aoi,))
	act_as(db, auditor, lease=page)
	assert db.execute(delete + ' RETURNING id', (aoi,)).fetchone()[0] == aoi


@pytest.mark.parametrize('processor_can_audit', [False, True])
def test_processor_and_owner_aoi_writes_are_not_audit_edits(lease_db, processor_can_audit):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	processor = processor_user(db, processor_can_audit)
	dataset = create_dataset(db, owner)
	act_as(db, auditor)
	claim(db, dataset, uuid.uuid4())

	# The processor's real payload has no source; it becomes a prediction and is not blocked.
	act_as(db, processor, email='processor@deadtrees.earth')
	prediction, source = db.execute(INSERT_AOI_WITHOUT_SOURCE, (dataset, processor, GEOMETRY)).fetchone()
	assert source == 'ml_prediction'
	db.execute('DELETE FROM public.v2_aois WHERE id=%s', (prediction,))

	# An owner label upload (same helper, no source) is the owner's data, not an audit edit.
	act_as(db, owner)
	upload, source = db.execute(INSERT_AOI_WITHOUT_SOURCE, (dataset, owner, GEOMETRY)).fetchone()
	assert source == 'manual'

	# Service-role maintenance is not an audit page and stays possible.
	as_admin(db)
	db.execute("UPDATE public.v2_aois SET notes='maintenance' WHERE id=%s", (upload,))
	db.execute('DELETE FROM public.v2_aois WHERE id=%s', (upload,))


def test_stale_page_cannot_delete_the_audit(lease_db):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	dataset = create_dataset(db, owner)
	page = uuid.uuid4()
	act_as(db, auditor)
	claim(db, dataset, page)
	act_as(db, auditor, lease=page)
	db.execute("INSERT INTO public.dataset_audit(dataset_id,audited_by,notes) VALUES (%s,%s,'saved')", (dataset, auditor))

	delete = 'DELETE FROM public.dataset_audit WHERE dataset_id=%s'
	act_as(db, auditor, lease=uuid.uuid4())
	expect_write_rejected(db, delete, (dataset,))
	act_as(db, auditor)
	expect_write_rejected(db, delete, (dataset,))
	act_as(db, auditor, lease=page)
	assert db.execute(delete + ' RETURNING dataset_id', (dataset,)).fetchone()[0] == dataset


def test_stale_page_cannot_move_a_leased_audit_to_another_dataset(lease_db):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	leased, unlocked = create_dataset(db, owner), create_dataset(db, owner)
	page = uuid.uuid4()
	act_as(db, auditor)
	claim(db, leased, page)
	act_as(db, auditor, lease=page)
	db.execute("INSERT INTO public.dataset_audit(dataset_id,audited_by,notes) VALUES (%s,%s,'saved')", (leased, auditor))

	move = 'UPDATE public.dataset_audit SET dataset_id=%s WHERE dataset_id=%s'
	for lease in (uuid.uuid4(), None, page):
		act_as(db, auditor, lease=lease)
		db.execute('SAVEPOINT move_audit')
		with pytest.raises(psycopg.errors.InsufficientPrivilege):
			db.execute(move, (unlocked, leased))
		db.execute('ROLLBACK TO SAVEPOINT move_audit')

	# Ordinary saves from the lease page still work; service-role maintenance may still move rows.
	act_as(db, auditor, lease=page)
	db.execute("UPDATE public.dataset_audit SET notes='resaved' WHERE dataset_id=%s", (leased,))
	as_admin(db)
	assert db.execute('SELECT notes FROM public.dataset_audit WHERE dataset_id=%s', (leased,)).fetchone()[0] == 'resaved'
	db.execute(move, (unlocked, leased))
	assert db.execute('SELECT dataset_id FROM public.dataset_audit WHERE dataset_id=%s', (unlocked,)).fetchone()[0] == unlocked


def test_lease_works_for_dataset_ids_beyond_32_bits(lease_db):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	dataset = 3_000_000_001  # above 2**31 - 1; bigint dataset ids must not overflow the lock key
	db.execute(
		"INSERT INTO public.v2_datasets(id,user_id,file_name,license,platform,data_access) VALUES (%s,%s,'high-id.tif','CC BY','drone','public')",
		(dataset, owner),
	)
	db.execute('INSERT INTO public.v2_statuses(dataset_id) VALUES (%s)', (dataset,))
	page = uuid.uuid4()

	act_as(db, auditor)
	assert claim(db, dataset, page)['acquired'] is True
	act_as(db, auditor, lease=page)
	db.execute("INSERT INTO public.dataset_audit(dataset_id,audited_by,notes) VALUES (%s,%s,'saved')", (dataset, auditor))
	act_as(db, auditor, lease=uuid.uuid4())
	expect_write_rejected(db, 'DELETE FROM public.dataset_audit WHERE dataset_id=%s', (dataset,))
	act_as(db, auditor)
	release(db, dataset, page)
	assert lock_row(db, dataset) is None


def test_owner_sees_review_in_progress_only_for_a_live_lease(lease_db):
	db = lease_db
	owner, auditor = create_user(db, False), create_user(db, True)
	legacy = create_dataset(db, owner, legacy_in_audit=True)
	leased = create_dataset(db, owner)
	act_as(db, auditor)
	claim(db, leased, uuid.uuid4())

	def owner_view_flags():
		act_as(db, owner)
		rows = db.execute(
			'SELECT id,is_in_audit FROM public.v2_full_dataset_view_owner WHERE id = ANY(%s)',
			([legacy, leased],),
		).fetchall()
		return dict(rows)

	assert owner_view_flags() == {legacy: False, leased: True}
	expire_lease(db, leased)
	assert owner_view_flags() == {legacy: False, leased: False}


# Concurrency: two real connections with committed data (rollback-only fixtures cannot show commit order).


@pytest.fixture
def committed_lease_dataset():
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}, 'Local database required'
	owner, first, second = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin', autocommit=True) as admin:
		dataset = None
		try:
			for user in (owner, first, second):
				admin.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, f'{user}@example.invalid'))
			for user in (first, second):
				admin.execute('INSERT INTO public.privileged_users(user_id,can_audit) VALUES (%s,true)', (user,))
			dataset = create_dataset(admin, owner)
			admin.execute("INSERT INTO public.dataset_audit(dataset_id,audited_by,notes) VALUES (%s,%s,'saved')", (dataset, first))
			yield admin, dataset, first, second
		finally:
			if dataset:
				for table in ('dataset_audit_locks', 'dataset_audit', 'v2_statuses'):
					admin.execute(f'DELETE FROM public.{table} WHERE dataset_id=%s', (dataset,))
				admin.execute('DELETE FROM public.v2_datasets WHERE id=%s', (dataset,))
			admin.execute('DELETE FROM public.privileged_users WHERE user_id = ANY(%s)', ([first, second],))
			admin.execute('DELETE FROM auth.users WHERE id = ANY(%s)', ([owner, first, second],))


def page_connection():
	return psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin')


def run_blocked(action):
	"""Runs ``action`` on another thread and records when it returned or raised."""
	outcome = {}

	def target():
		try:
			outcome['result'] = action()
		except Exception as error:  # noqa: BLE001 - asserted by the caller
			outcome['error'] = error
		outcome['finished_at'] = time.monotonic()

	thread = threading.Thread(target=target)
	thread.start()
	return thread, outcome


def claim_and_commit(user, dataset, lease, take_over):
	with page_connection() as conn:
		act_as(conn, user)
		result = claim(conn, dataset, lease, take_over)
		conn.commit()
		return result


@pytest.mark.parametrize('handover', ['same_auditor_takeover', 'other_auditor_claims_expired_lease'])
def test_lease_handover_waits_for_an_in_flight_audit_write(committed_lease_dataset, handover):
	admin, dataset, first, second = committed_lease_dataset
	old_page, new_page = uuid.uuid4(), uuid.uuid4()
	with page_connection() as conn:
		act_as(conn, first)
		claim(conn, dataset, old_page)
		conn.commit()
	claimant = first
	if handover == 'other_auditor_claims_expired_lease':
		admin.execute("UPDATE public.dataset_audit_locks SET expires_at=now()-interval '1 second' WHERE dataset_id=%s", (dataset,))
		claimant = second

	with page_connection() as writer:
		act_as(writer, first, lease=old_page)
		writer.execute("UPDATE public.dataset_audit SET notes='old page' WHERE dataset_id=%s", (dataset,))

		thread, outcome = run_blocked(lambda: claim_and_commit(claimant, dataset, new_page, take_over=True))
		thread.join(timeout=1)
		assert thread.is_alive(), 'the handover must wait for the in-flight audit write'
		write_committed_at = time.monotonic()
		writer.commit()

	thread.join(timeout=10)
	assert outcome['result']['acquired'] is True
	assert outcome['finished_at'] > write_committed_at
	assert admin.execute('SELECT notes FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 'old page'
	assert admin.execute('SELECT holder_id,lease_id FROM public.dataset_audit_locks WHERE dataset_id=%s', (dataset,)).fetchone() == (claimant, new_page)


def test_audit_write_waits_for_an_in_flight_takeover_and_is_then_rejected(committed_lease_dataset):
	admin, dataset, first, _ = committed_lease_dataset
	old_page, new_page = uuid.uuid4(), uuid.uuid4()
	with page_connection() as conn:
		act_as(conn, first)
		claim(conn, dataset, old_page)
		conn.commit()

	def stale_write():
		with page_connection() as writer:
			act_as(writer, first, lease=old_page)
			writer.execute("UPDATE public.dataset_audit SET notes='stale page' WHERE dataset_id=%s", (dataset,))
			writer.commit()

	with page_connection() as claimer:
		act_as(claimer, first)
		assert claim(claimer, dataset, new_page, take_over=True)['acquired'] is True
		thread, outcome = run_blocked(stale_write)
		thread.join(timeout=1)
		assert thread.is_alive(), 'the audit write must wait for the in-flight takeover'
		takeover_committed_at = time.monotonic()
		claimer.commit()

	thread.join(timeout=10)
	assert isinstance(outcome.get('error'), psycopg.errors.ObjectInUse)
	assert outcome['finished_at'] > takeover_committed_at
	assert admin.execute('SELECT notes FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 'saved'
