-- Add CASCADE delete to reference_datasets foreign key
-- When a dataset is deleted, automatically remove it from reference_datasets

-- Drop existing constraint
ALTER TABLE public.reference_datasets
DROP CONSTRAINT IF EXISTS reference_datasets_dataset_id_fkey;

-- Recreate with ON DELETE CASCADE
ALTER TABLE public.reference_datasets
ADD CONSTRAINT reference_datasets_dataset_id_fkey 
FOREIGN KEY (dataset_id) 
REFERENCES public.v2_datasets(id) 
ON DELETE CASCADE;

