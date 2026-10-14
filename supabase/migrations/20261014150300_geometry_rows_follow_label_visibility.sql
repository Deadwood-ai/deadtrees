-- Deadwood and forest cover rows now follow their label's visibility.
--
-- Both geometry policies repeated the v2_labels visibility rule, calling
-- auth.uid(), can_view_all_private_data() and
-- internal.is_dataset_excluded_from_public_surface() once per row. Postgres
-- applies a row policy before any non-leakproof filter such as the tile bbox, so
-- every map tile evaluated the rule for every polygon of the label. Anonymous
-- tiles hit the 3 s statement timeout from a few thousand polygons per label,
-- which left the layers of most medium and large datasets blank.
--
-- The v2_labels policy is the canonical form of the same rule; it resolves the
-- caller once per query through initplans and set-based helpers. Each geometry
-- row now asks only whether its label is visible. The rule and its owner are
-- unchanged, so no reader gains or loses rows.

begin;

-- Locks are taken in one order: v2_deadwood_geometries, then v2_forest_cover_geometries.
set local lock_timeout = '5s';

alter policy "Allow visible dataset deadwood geometries read access" on public.v2_deadwood_geometries
using (exists (select 1 from public.v2_labels label where label.id = v2_deadwood_geometries.label_id));

alter policy "Allow visible dataset forest cover geometries read access" on public.v2_forest_cover_geometries
using (exists (select 1 from public.v2_labels label where label.id = v2_forest_cover_geometries.label_id));

commit;
