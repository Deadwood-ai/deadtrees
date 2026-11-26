-- The georeferencing check estimates an offset; it no longer judges it (DT-1616).
--
-- audit.georef_output_v1 turned the processor's call into a verdict at 15 m: not passed for a
-- lost coordinate, and a person asked whenever a reference's p90 crossed 15 m under a quadrant
-- holdout or the references disagreed about 15 m. That put datasets into review whose offset
-- was well measured (15426: three references agree on 3 to 8 m; Esri Clarity's holdouts 8,
-- 13 and 31 m made the whole check uncertain). Now the output has no 15 m line: it is the
-- median offset of the references that matched well, read from each reference's raw numbers
-- (not the processor's flags and votes, which hold its coverage, holdout and 15 m tests); a
-- person is asked only when references matched plenty but not well enough; and it says when
-- no reference imagery matched. Passed and not passed come only from a person's review answer,
-- which replaces the status shown; a person can also answer that there is no reference
-- imagery. The processor keeps storing its decision, reason and evidence as before.
-- audit.dataset_outcomes is unchanged: its review_required 'georef' item (needs_review and no
-- current review) follows the new rules through the function.
set local lock_timeout = '5s';

-- Georeferencing output (docs/georef-check.md), from each reference's matches. A reference
-- counts when its fitted shift rests on enough consistent matches spread over the image and it
-- measured an offset (p90_m); the thresholds are in the rules row.
--   estimated     offset_m is the median p90 of the references that count
--   needs_review  none counts, but one has plenty of matches (bunched or inconsistent): a
--                 person compares the images
--   no_reference  no reference imagery matched
create or replace function audit.georef_output_v1(p_check public.v2_georef_checks)
returns jsonb
language sql immutable set search_path = ''
as $$
	with rules as (
		select 100 as min_inliers,           -- matches consistent with the fitted shift
			0.5::real as min_inlier_fraction, -- share of the confident matches that are inliers
			4 as min_cells                    -- of the 16 image grid cells holding an inlier
	), refs as (
		select (e ->> 'p90_m')::real as p90_m,
			coalesce((e ->> 'inliers')::integer, 0) >= r.min_inliers as plenty,
			coalesce((e ->> 'inliers')::integer, 0) >= r.min_inliers
				and coalesce((e ->> 'inlier_fraction')::real, 0) >= r.min_inlier_fraction
				and coalesce((e ->> 'cells')::integer, 0) >= r.min_cells
				and e ->> 'p90_m' is not null as counts
		from jsonb_array_elements(p_check.reference_evidence) e
		cross join rules r
	)
	select case
		when bool_or(counts) then jsonb_build_object('status', 'estimated', 'offset_m',
			round((percentile_cont(0.5) within group (order by p90_m) filter (where counts))::numeric, 2))
		when bool_or(plenty) then jsonb_build_object('status', 'needs_review', 'offset_m', null)
		else jsonb_build_object('status', 'no_reference', 'offset_m', null)
	end
	from refs;
$$;

-- A person's georeferencing answer: passed (within 15 m), not passed, or no reference imagery
-- (nothing to compare the dataset with).
alter table audit.dataset_human_reviews
	drop constraint dataset_human_reviews_georef_status_check,
	add constraint dataset_human_reviews_georef_status_check
		check (georef_status in ('passed', 'not_passed', 'no_reference'));
