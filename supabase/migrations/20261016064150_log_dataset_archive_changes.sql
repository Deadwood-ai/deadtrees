-- Record archiving and restoring a dataset in v2_dataset_edit_history.
-- Archiving is the user-facing delete (DataTable), so without this there is no
-- trace of who archived a dataset or when. The function body is otherwise
-- unchanged; like the other fields, only changes made with a user JWT are logged.

CREATE OR REPLACE FUNCTION public.log_dataset_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  current_user_id uuid;
BEGIN
  -- Get the current user ID, handling both regular users and processor
  IF (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text THEN
    -- For processor user, we need to get the user_id from auth.users table
    SELECT id INTO current_user_id
    FROM auth.users
    WHERE email = 'processor@deadtrees.earth';
  ELSE
    -- For regular authenticated users
    current_user_id := auth.uid();
  END IF;

  -- Only log changes if we have a valid user_id
  IF current_user_id IS NOT NULL THEN
    -- Log each changed field
    IF OLD.authors IS DISTINCT FROM NEW.authors THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'authors', to_jsonb(OLD.authors), to_jsonb(NEW.authors));
    END IF;

    IF OLD.aquisition_year IS DISTINCT FROM NEW.aquisition_year THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'aquisition_year', to_jsonb(OLD.aquisition_year), to_jsonb(NEW.aquisition_year));
    END IF;

    IF OLD.aquisition_month IS DISTINCT FROM NEW.aquisition_month THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'aquisition_month', to_jsonb(OLD.aquisition_month), to_jsonb(NEW.aquisition_month));
    END IF;

    IF OLD.aquisition_day IS DISTINCT FROM NEW.aquisition_day THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'aquisition_day', to_jsonb(OLD.aquisition_day), to_jsonb(NEW.aquisition_day));
    END IF;

    IF OLD.platform IS DISTINCT FROM NEW.platform THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'platform', to_jsonb(OLD.platform), to_jsonb(NEW.platform));
    END IF;

    IF OLD.citation_doi IS DISTINCT FROM NEW.citation_doi THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'citation_doi', to_jsonb(OLD.citation_doi), to_jsonb(NEW.citation_doi));
    END IF;

    IF OLD.additional_information IS DISTINCT FROM NEW.additional_information THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'additional_information', to_jsonb(OLD.additional_information), to_jsonb(NEW.additional_information));
    END IF;

    IF OLD.archived IS DISTINCT FROM NEW.archived THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'archived', to_jsonb(OLD.archived), to_jsonb(NEW.archived));
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
