-- PROP-026: Component image gallery (paste, drop, or pick from disk)
-- Images stored in Supabase Storage (documents bucket, component-images/ prefix).
-- No versioning — images are add/delete only.
CREATE TABLE component_images (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  component_id    UUID NOT NULL REFERENCES bom_components(id),
  storage_path    VARCHAR(400) NOT NULL,
  file_name       VARCHAR(200) NOT NULL,
  content_type    VARCHAR(100) NOT NULL DEFAULT 'image/png',
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by     UUID REFERENCES users(id)
);

ALTER TABLE component_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON component_images FOR ALL USING (false);

CREATE INDEX idx_component_images_component ON component_images (component_id);
