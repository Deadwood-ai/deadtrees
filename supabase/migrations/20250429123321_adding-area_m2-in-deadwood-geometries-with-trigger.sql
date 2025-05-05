alter table "public"."v2_deadwood_geometries" add column "area_m2" double precision;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.update_area_m2()
 RETURNS trigger
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  NEW.area_m2 := ST_Area(ST_Transform(NEW.geometry, 3857));
  RETURN NEW;
END;
$function$
;

CREATE TRIGGER trg_update_area_m2 BEFORE INSERT OR UPDATE OF geometry ON public.v2_deadwood_geometries FOR EACH ROW EXECUTE FUNCTION update_area_m2();


