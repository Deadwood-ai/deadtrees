-- Enable RLS
ALTER TABLE "public"."v2_aois" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."v2_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."v2_label_geometries" ENABLE ROW LEVEL SECURITY;

-- AOIs policies
CREATE POLICY "Allow public read access to AOIs"
ON "public"."v2_aois"
FOR SELECT TO public
USING (true);

CREATE POLICY "Allow authenticated users to create AOIs"
ON "public"."v2_aois"
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow users to update their own AOIs"
ON "public"."v2_aois"
FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Labels policies
CREATE POLICY "Allow public read access to labels"
ON "public"."v2_labels"
FOR SELECT TO public
USING (true);

CREATE POLICY "Allow authenticated users to create labels"
ON "public"."v2_labels"
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow users to update their own labels"
ON "public"."v2_labels"
FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Label geometries policies
CREATE POLICY "Allow public read access to label geometries"
ON "public"."v2_label_geometries"
FOR SELECT TO public
USING (true);

CREATE POLICY "Allow authenticated users to create label geometries"
ON "public"."v2_label_geometries"
FOR INSERT TO authenticated
WITH CHECK (EXISTS (
    SELECT 1 FROM "public"."v2_labels" 
    WHERE id = label_id AND user_id = auth.uid()
));

CREATE POLICY "Allow users to update their own label geometries"
ON "public"."v2_label_geometries"
FOR UPDATE TO authenticated
USING (EXISTS (
    SELECT 1 FROM "public"."v2_labels" 
    WHERE id = label_id AND user_id = auth.uid()
))
WITH CHECK (EXISTS (
    SELECT 1 FROM "public"."v2_labels" 
    WHERE id = label_id AND user_id = auth.uid()
)); 