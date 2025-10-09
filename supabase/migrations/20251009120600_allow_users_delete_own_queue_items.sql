-- Allow users to delete their own queue items (for canceling/requeuing)
-- This enables the rerun functionality where users can clean up old queue entries

DROP POLICY IF EXISTS "Enable delete for users based on email" ON public.v2_queue;

CREATE POLICY "Enable delete for processor and own items"
ON public.v2_queue
FOR DELETE
USING (
	-- Processor can delete anything
	(auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text
	OR
	-- Users can delete their own queue items
	auth.uid() = user_id
);

