-- Benchmarks grow through an open version (DT-1470): operators add review-page targets,
-- and auditors label them in the app. See docs/audit-checks.md, Benchmarks.
--
-- A frozen version never changes, so a bigger set is a new version. Each check has at
-- most one open (unfrozen) version; that is where new targets go. Truth stays in
-- audit.assessments, keyed by target: a new version on the same crops or datasets keeps
-- every person row already given on them. Auditors already store their own person rows
-- on any target, with or without a run ("Auditors store their own assessments").
set local lock_timeout = '5s';

create unique index benchmarks_one_open_version_per_check on audit.benchmarks (check_key) where frozen_at is null;

-- Adds a crop (crop_id) or a whole dataset (crop_id null) to the open version of a check's
-- benchmark and returns its member row; a target already in it is returned as it is.
-- The split follows the dataset: the side it already has in a benchmark of the check,
-- else audit.benchmark_split. A benchmark holds crops or datasets, not both. The crop
-- joins the 'benchmark' crop set. The member guard (frozen, one split per dataset) still
-- runs. Operators only.
create function audit.add_benchmark_target(p_check_key text, p_dataset_id bigint, p_crop_id bigint default null)
returns audit.benchmark_members
language plpgsql security definer set search_path = ''
as $$
declare
	v_benchmark bigint;
	v_split text;
	v_member audit.benchmark_members;
begin
	if not public.can_operate() then
		raise exception 'Only operators add benchmark targets' using errcode = '42501';
	end if;
	-- held until commit, so the version cannot be frozen under the insert
	select id into v_benchmark from audit.benchmarks
	where check_key = p_check_key and frozen_at is null
	for share;
	if v_benchmark is null then
		raise exception 'Check % has no open benchmark version', p_check_key using errcode = 'P0002';
	end if;
	if exists (
		select 1 from audit.benchmark_members
		where benchmark_id = v_benchmark and (crop_id is null) <> (p_crop_id is null)
	) then
		raise exception 'This benchmark holds %, not %',
			case when p_crop_id is null then 'crops' else 'datasets' end,
			case when p_crop_id is null then 'datasets' else 'crops' end
			using errcode = '23514';
	end if;
	select m.split into v_split
	from audit.benchmark_members m
	join audit.benchmarks b on b.id = m.benchmark_id
	where b.check_key = p_check_key and m.dataset_id = p_dataset_id
	order by m.benchmark_id = v_benchmark desc, b.created_at desc, m.id
	limit 1;
	insert into audit.benchmark_members (benchmark_id, dataset_id, crop_id, split)
	values (v_benchmark, p_dataset_id, p_crop_id, coalesce(v_split, audit.benchmark_split(p_dataset_id)))
	on conflict (benchmark_id, dataset_id, crop_id) do nothing;
	if p_crop_id is not null then
		update audit.crops set crop_sets = crop_sets || '{benchmark}'
		where id = p_crop_id and dataset_id = p_dataset_id and not crop_sets @> '{benchmark}';
	end if;
	select * into v_member from audit.benchmark_members
	where benchmark_id = v_benchmark and dataset_id = p_dataset_id and crop_id is not distinct from p_crop_id;
	return v_member;
end;
$$;
revoke all on function audit.add_benchmark_target(text, bigint, bigint) from public, anon;
grant execute on function audit.add_benchmark_target(text, bigint, bigint) to authenticated, service_role;

-- pq-gold-dt1272 v2: open, with v1's crops and their frozen splits. Only where v1 exists
-- (production, after the gold import); elsewhere there is nothing to grow from.
with v1 as (
	select id, created_by from audit.benchmarks where name = 'pq-gold-dt1272' and version = 'v1'
), v2 as (
	insert into audit.benchmarks (check_key, name, version, description, created_by)
	select 'prediction_quality', 'pq-gold-dt1272', 'v2',
		'v1 plus crops added from the review page and labeled in the app', created_by
	from v1
	on conflict (name, version) do nothing
	returning id
)
insert into audit.benchmark_members (benchmark_id, dataset_id, crop_id, split, added_at)
select v2.id, m.dataset_id, m.crop_id, m.split, m.added_at
from v2, v1
join audit.benchmark_members m on m.benchmark_id = v1.id;

-- The dataset evaluation's gold set starts open and empty; its members are the picked
-- datasets (scripts/audit_import.py evaluation-gold) and datasets added from the review page.
insert into audit.benchmarks (check_key, name, version, description)
values ('dataset_evaluation', 'dataset-evaluation-gold', 'v1',
	'Datasets picked for the dataset evaluation gold set (DT-1483) and added from the review page')
on conflict (name, version) do nothing;
