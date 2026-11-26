-- The dataset evaluation's pre-rewrite runs are read with "Haiku decides" (DT-1610).
--
-- 20261126120000 gave the dataset evaluation's v1 and v2 the rule set "call": "recorded", so
-- each run kept the verdict its old rule had stored. That rule also weighed a duplicate check
-- across datasets and the models' disagreement, neither of which exists any more: 75 of the
-- runs stayed "unsure" and asked for a review although the deciding model mostly said OK.
-- Each recorded rule set is now replaced by the rule new runs use (processor
-- dataset_evaluation_v1: the deciding judge haiku, the band check at 90), and the views work
-- the calls out again from the stored judgements. No model is asked again.
set local lock_timeout = '5s';

insert into audit.check_rules (version_id, name, config)
select r.version_id, 'rules-v2',
	jsonb_build_object('decider', 'haiku', 'band_major_at', coalesce((r.config ->> 'band_major_at')::integer, 90))
from audit.check_rules r
where r.is_active and r.config ->> 'call' = 'recorded'
on conflict (version_id, name) do nothing;

-- one active rule set per version: switch the recorded ones off first
update audit.check_rules r
set is_active = false
where r.is_active and r.config ->> 'call' = 'recorded';

update audit.check_rules r
set is_active = true, activated_at = now()
where r.name = 'rules-v2'
	and r.config ->> 'decider' = 'haiku'
	and not exists (select 1 from audit.check_rules o where o.version_id = r.version_id and o.is_active)
	and exists (select 1 from audit.check_versions v where v.id = r.version_id and v.check_key = 'dataset_evaluation');
