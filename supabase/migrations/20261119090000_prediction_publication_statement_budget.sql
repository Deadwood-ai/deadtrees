-- Give prediction publication the same 90 s budget as large geometry inserts.
--
-- Publication counts the staged label's rows to confirm the upload is complete.
-- On a freshly uploaded label that count reads every new heap row, and the
-- combined model now produces labels of 400k-800k tree cover polygons: a 440k
-- label took 6.7 s and an 800k label exceeded the authenticated role's 8 s
-- statement_timeout, so publication was cancelled after a complete upload
-- (DT-721, datasets 13413, 12448, 661). PostgREST >= 12.2 applies a function's
-- statement_timeout setting to the RPC call, as for insert_large_label_geometry.
-- Both functions stay processor-only and unchanged otherwise.

alter function public.publish_model_prediction_label(bigint, bigint) set statement_timeout = '90s';
alter function public.replace_model_prediction_label(bigint, bigint) set statement_timeout = '90s';

notify pgrst, 'reload schema';
