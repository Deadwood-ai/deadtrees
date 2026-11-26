-- A person's "can't tell what the tile shows" is the verdict ambiguous (DT-1607).
--
-- The rewrite (20261126120000) carried the earlier audit's "can't tell what it shows" answers
-- over as not_assessable on tile_human_reviews. People now answer that as ambiguous: no one can
-- reliably tell what is right on the tile. not_assessable stays a model's answer only (it could
-- not assess the image). Both give no Major/Minor/OK call in audit.tile_calls, so no count
-- changes.
set local lock_timeout = '5s';

update audit.tile_human_reviews set verdict = 'ambiguous' where verdict = 'not_assessable';

alter table audit.tile_human_reviews
	add constraint tile_human_reviews_verdict_check check (verdict <> 'not_assessable');
