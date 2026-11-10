-- The georef check version the checks so far ran on becomes the active one (DT-1485,
-- docs/audit-checks.md). Only an active version's runs move audit.current_runs
-- (migration 20261103103000), so without this every new georef check would stay a shadow
-- run and never reach audit.review_queue. The version keeps its review_all mode: every
-- result goes to a person. The existing current runs are untouched.
--
-- A database without that version (fresh local or CI) is left as it is: there the
-- version is registered inactive on first use, as for every check.

set local lock_timeout = '5s';

update audit.check_versions
set is_active = true
where check_key = 'georef'
	and version = 'georef-rules-v1_romav2.0.1'
	and not exists (select 1 from audit.check_versions where check_key = 'georef' and is_active);
