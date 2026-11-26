-- Prediction quality has a crop benchmark per layer: deadwood and tree cover are labeled, grown
-- and frozen apart, each with its own versions. See docs/audit-checks.md, Benchmarks.
--
-- A benchmark names the layer it scores; null for a check judged as a whole (the dataset
-- evaluation). Each check and layer has at most one open version, where new targets go.
set local lock_timeout = '5s';

alter table audit.benchmarks add column layer text check (layer in ('deadwood', 'forest_cover'));

drop index audit.benchmarks_one_open_version_per_check;
create unique index benchmarks_one_open_version on audit.benchmarks (check_key, layer) nulls not distinct
where frozen_at is null;

-- the layer is part of what a benchmark is: it never changes
create or replace function internal.guard_audit_benchmark()
returns trigger
language plpgsql set search_path = ''
as $$
begin
	if old.frozen_at is not null then
		raise exception 'Benchmark %/% is frozen; create a new version instead', old.name, old.version
			using errcode = '55000';
	end if;
	if tg_op = 'DELETE' then
		return old;
	end if;
	if (new.check_key, new.layer, new.name, new.version, new.created_by, new.created_at)
		is distinct from (old.check_key, old.layer, old.name, old.version, old.created_by, old.created_at) then
		raise exception 'Only the description and frozen_at of a benchmark change' using errcode = '55000';
	end if;
	return new;
end;
$$;

-- add_benchmark_target and remove_benchmark_target take the layer of the benchmark they change
-- (null for the dataset evaluation); otherwise they work as before.
drop function audit.add_benchmark_target(text, bigint, bigint);
drop function audit.remove_benchmark_target(text, bigint, bigint);

-- Adds a crop (crop_id) or a whole dataset (crop_id null) to the open version of a check's
-- benchmark for the layer and returns its member row; a target already in it is returned as
-- it is. The split follows the dataset: the side it already has in a benchmark of the check
-- (any layer), else audit.benchmark_split. A benchmark holds crops or datasets, not both. The
-- crop joins the 'benchmark' crop set. The member guard (frozen, one split per dataset) still
-- runs. Operators only.
create function audit.add_benchmark_target(p_check_key text, p_dataset_id bigint, p_crop_id bigint default null, p_layer text default null)
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
	where check_key = p_check_key and layer is not distinct from p_layer and frozen_at is null
	for share;
	if v_benchmark is null then
		raise exception 'Check % has no open benchmark version%', p_check_key, coalesce(' for layer ' || p_layer, '')
			using errcode = 'P0002';
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
revoke all on function audit.add_benchmark_target(text, bigint, bigint, text) from public, anon;
grant execute on function audit.add_benchmark_target(text, bigint, bigint, text) to authenticated, service_role;

-- Takes a crop, or a dataset with all its crops (crop_id null), out of the open version of a
-- check's benchmark for the layer again; returns the member rows it removed. Operators only.
create function audit.remove_benchmark_target(p_check_key text, p_dataset_id bigint, p_crop_id bigint default null, p_layer text default null)
returns setof audit.benchmark_members
language plpgsql security definer set search_path = ''
as $$
declare
	v_benchmark bigint;
begin
	if not public.can_operate() then
		raise exception 'Only operators remove benchmark targets' using errcode = '42501';
	end if;
	-- held until commit, so the version cannot be frozen under the delete
	select id into v_benchmark from audit.benchmarks
	where check_key = p_check_key and layer is not distinct from p_layer and frozen_at is null
	for share;
	if v_benchmark is null then
		raise exception 'Check % has no open benchmark version%', p_check_key, coalesce(' for layer ' || p_layer, '')
			using errcode = 'P0002';
	end if;
	return query
	delete from audit.benchmark_members
	where benchmark_id = v_benchmark
	  and dataset_id = p_dataset_id
	  and (p_crop_id is null or crop_id = p_crop_id)
	returning *;
end;
$$;
revoke all on function audit.remove_benchmark_target(text, bigint, bigint, text) from public, anon;
grant execute on function audit.remove_benchmark_target(text, bigint, bigint, text) to authenticated, service_role;

-- The open prediction quality benchmark without a layer (pq-gold-dt1272 v2 in production)
-- splits into one per layer: both open with all its crops on their sides, and it is frozen as
-- it stands. Truth is keyed by crop and layer, so every label on its crops carries over to the
-- layer it answers. Where there is none (a fresh database), there is nothing to split.
with whole as (
	select id, name, version, created_by from audit.benchmarks
	where check_key = 'prediction_quality' and layer is null and frozen_at is null
), per_layer as (
	insert into audit.benchmarks (check_key, layer, name, version, description, created_by)
	select 'prediction_quality', l.layer, l.name, 'v1',
		format('The %s of %s %s''s crops, plus crops added from the review page', l.what, w.name, w.version), w.created_by
	from whole w
	cross join (values ('deadwood', 'pq-deadwood-gold', 'deadwood'), ('forest_cover', 'pq-forest-cover-gold', 'tree cover'))
		as l (layer, name, what)
	on conflict (name, version) do nothing
	returning id
)
insert into audit.benchmark_members (benchmark_id, dataset_id, crop_id, split, added_at)
select p.id, m.dataset_id, m.crop_id, m.split, m.added_at
from per_layer p, whole w
join audit.benchmark_members m on m.benchmark_id = w.id;

update audit.benchmarks
set frozen_at = now(), description = description || ' Frozen when it split into pq-deadwood-gold and pq-forest-cover-gold v1.'
where check_key = 'prediction_quality' and layer is null and frozen_at is null;
