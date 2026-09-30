-- 20260930140000 closed v2_logs to API roles because the shared log handler now
-- writes with the service role. Processor hosts that have not yet redeployed
-- still write with the processor login, and each host redeploys only after it
-- drains, so their log lines (factory evidence, Linear failure context) would be
-- lost in the meantime. The processor is the trusted writer: let it insert.
grant insert on table public.v2_logs to authenticated;

create policy "Processor writes logs"
on public.v2_logs for insert to authenticated
with check ((select auth.jwt() ->> 'email') = 'processor@deadtrees.earth');
