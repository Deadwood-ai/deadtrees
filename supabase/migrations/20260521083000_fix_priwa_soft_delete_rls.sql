create or replace function public.priwa_set_kaeferbaum_actor_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    current_actor uuid := (select auth.uid());
begin
    if TG_OP = 'INSERT' then
        if current_actor is not null then
            NEW.created_by = coalesce(NEW.created_by, current_actor);
            NEW.updated_by = coalesce(NEW.updated_by, current_actor);
            if NEW.deleted_at is not null then
                NEW.deleted_by = current_actor;
            end if;
        end if;

        NEW.created_at = now();
        NEW.updated_at = NEW.created_at;
        return NEW;
    end if;

    NEW.id = OLD.id;
    NEW.project_id = OLD.project_id;
    NEW.created_at = OLD.created_at;
    NEW.created_by = OLD.created_by;
    NEW.updated_at = now();

    if current_actor is not null then
        NEW.updated_by = current_actor;

        if NEW.deleted_at is null then
            NEW.deleted_by = null;
        elsif OLD.deleted_at is null then
            NEW.deleted_by = current_actor;
        end if;
    end if;

    return NEW;
end;
$$;

drop policy if exists "PRIWA members can read active kaeferbaeume"
on "public"."priwa_kaeferbaeume";

create policy "PRIWA members can read kaeferbaeume"
on "public"."priwa_kaeferbaeume"
as permissive
for select
to authenticated
using (public.priwa_is_project_member(project_id));

drop policy if exists "PRIWA members can update kaeferbaeume"
on "public"."priwa_kaeferbaeume";

create policy "PRIWA members can update kaeferbaeume"
on "public"."priwa_kaeferbaeume"
as permissive
for update
to authenticated
using (
    deleted_at is null
    and public.priwa_is_project_member(project_id)
)
with check (public.priwa_is_project_member(project_id));
