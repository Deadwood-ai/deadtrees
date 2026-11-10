-- audit.disagreements compared a person's answer with the set of every automated
-- verdict on the target. That held while a target had one model row. The dataset
-- evaluation writes two model rows and a rule row per dataset, and the prediction
-- quality check two model rows per crop: whenever those differ among themselves, no
-- person answer equals the set, so every answered target would be listed as a
-- disagreement, also when the reviewer confirmed the check's verdict.
--
-- The person is now compared with the automated call, read the way
-- audit.review_queue and the review page read it: the target's rule rows where it
-- has any, else its model rows; the worst verdict counts. An unsure call is no call:
-- the reviewer's answer settles it and is not a disagreement. People disagreeing
-- with each other are listed as before. Columns and access are unchanged.

set local lock_timeout = '5s';

create or replace view audit.disagreements
with (security_invoker = true)
as
with counted as (
	-- filter to the current run first, so a newer run that is not current yet
	-- cannot hide the current run's answers
	select distinct on (a.check_key, a.dataset_id, a.crop_id, a.layer, a.assessor) a.*
	from (
		select * from audit.assessments where assessor_kind = 'person'
		union all
		select * from audit.current_assessments
	) a
	order by a.check_key, a.dataset_id, a.crop_id, a.layer, a.assessor, a.imported_from is not null, a.created_at desc, a.id desc
), targets as (
	select
		check_key, dataset_id, crop_id, layer,
		jsonb_object_agg(assessor, verdict order by assessor) as verdicts,
		array_agg(distinct verdict) filter (where assessor_kind = 'person' and imported_from is null) as people,
		array_agg(distinct verdict) filter (where imported_from is not null) as legacy,
		coalesce(
			array_agg(distinct verdict) filter (where assessor_kind = 'rule'),
			array_agg(distinct verdict) filter (where assessor_kind = 'model')
		) as automated,
		max(created_at) as last_assessed_at
	from counted
	group by check_key, dataset_id, crop_id, layer
), called as (
	select
		t.*,
		case
			when 'major' = any(t.automated) then 'major'
			when 'unsure' = any(t.automated) then null
			when 'minor' = any(t.automated) then 'minor'
			when t.automated is not null then 'ok'
		end::audit.verdict as call
	from targets t
)
select
	check_key, dataset_id, crop_id, layer, verdicts,
	coalesce(cardinality(people) > 1, false) as people_disagree,
	-- an array holding a null compares as different from any other, so the missing call is named
	coalesce(call is not null and people <> array[call], false) as people_and_models_disagree,
	coalesce(call is not null and legacy <> array[call], false) as legacy_and_models_disagree,
	last_assessed_at
from called
where cardinality(people) > 1
	or (call is not null and (people <> array[call] or legacy <> array[call]));
