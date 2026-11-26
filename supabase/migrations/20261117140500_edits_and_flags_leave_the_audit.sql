-- User reports and the edits users suggest to predictions are not part of the audit: they have
-- their own page (Edits & flags on the audit page), and an audit lease no longer guards them. An
-- auditor reviews them, or edits a prediction, while another auditor has the dataset's audit open.
-- The lease still guards the audit's own writes (the manual AOI).
set local lock_timeout = '5s';

drop trigger validate_flag_audit_lease on public.dataset_flags;
drop trigger validate_correction_audit_lease on public.v2_geometry_corrections;
