-- Archive the datasets the old manual audit excluded as duplicates (DT-1613).
--
-- Duplicates were removed in two ways: archived (api/src/upload/existing_duplicates.py, which
-- archives byte-identical copies) or excluded in the old manual audit with the reason in its
-- notes. The excluded ones still showed up in the Audit Review. They are archived the same way
-- as the cleanup does it, without an e-mail to the owners. The ids are listed so the change is
-- exactly what was reviewed (production survey of 26 Nov 2026):
--   - 108 exclusions whose notes say duplicate ("duplicate on same day", "Duplicate with 4932");
--     every original a note names stays (4480 for 4478/4479, 5187 for 5185/5186/5188);
--   - 15 whose notes say "double" and that have a kept dataset of the same flight (same day,
--     overlapping footprint). 10 more "double" ones without such a dataset are left alone.
-- None is part of a data publication. Rows already archived are left as they are.
set local lock_timeout = '5s';

update public.v2_datasets
set archived = true
where not archived
	and id = any (array[
		4238, 4478, 4479, 4509, 4513, 4700, 4707, 4708, 4713, 4720, 4721, 4722, 4746, 4772, 4902, 4926,
		4927, 4936, 4988, 5089, 5093, 5104, 5106, 5107, 5109, 5111, 5112, 5182, 5185, 5186, 5188, 5437,
		5500, 5502, 5689, 5692, 5694, 6096, 6119, 8146, 8804, 9674, 9680, 9681, 9682, 9683, 9684, 9685,
		9686, 9687, 9690, 9691, 9692, 9693, 9694, 9703, 9704, 9705, 9706, 9707, 9708, 9709, 9710, 9712,
		9713, 9714, 9715, 9716, 9717, 9718, 9719, 9720, 9722, 9736, 9738, 9751, 9752, 9753, 9754, 9755,
		9756, 9757, 9759, 9772, 9773, 9774, 9775, 9776, 9777, 9778, 9779, 9780, 9781, 9783, 9784, 9785,
		9786, 9787, 9788, 9789, 9790, 9791, 9792, 9793, 9794, 9795, 9796, 9797,
		-- "double", with a kept dataset of the same flight
		4322, 4323, 4324, 4327, 4328, 4329, 4330, 4345, 4380, 4381, 4433, 4484, 4661, 5253, 5835
	]::bigint[]);
