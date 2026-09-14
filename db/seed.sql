-- ============================================================================
-- WCT Job Application System — minimal seed data
--
-- Only the entity/company categories (spec §6.6 "Entity/company categories
-- (seed list, admin-extensible)"). No fake companies, users, admins, or
-- applications are seeded here — those are real operational data, not
-- schema fixtures, and should be created through the API (or a genuine
-- data migration from the old system) rather than invented here.
-- ============================================================================

INSERT INTO entity_categories (name) VALUES
  ('E&C'),
  ('Aviation'),
  ('Hotel'),
  ('Property'),
  ('F&B'),
  ('Malls'),
  ('REIT')
ON CONFLICT (name) DO NOTHING;
