-- An answer on a crop's prediction layer can be ambiguous: no one can reliably tell
-- what is right there (the shrub to tree transition, an unusual kind of dieback). Its own
-- migration, so the next ones can use the new value; 20261117140000 limits it to those rows.
set local lock_timeout = '5s';

alter type audit.verdict add value if not exists 'ambiguous';
