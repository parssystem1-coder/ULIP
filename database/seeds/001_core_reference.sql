-- 001_core_reference.sql — demo/reference seed (development & staging only).
-- Deterministic IDs for stable down-seeds and tests.

BEGIN;

-- Development tenant
INSERT INTO tenants (id, name, status) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Dev Tenant', 'ACTIVE');

INSERT INTO users (id, tenant_id, email, name, role, status) VALUES
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
   'owner@dev.local', 'Dev Owner', 'OWNER', 'ACTIVE');

-- =====================================================================
-- Taxonomy: BusinessType → Industry → Specialty
-- Business Type is a first-class concept; Profession is NOT used.
-- =====================================================================

-- Business Types
INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', NULL, 'BUSINESS_TYPE', 'Service Provider', 'service-provider'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', NULL, 'BUSINESS_TYPE', 'Retailer',         'retailer'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', NULL, 'BUSINESS_TYPE', 'Wholesaler',       'wholesaler'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', NULL, 'BUSINESS_TYPE', 'Manufacturer',     'manufacturer'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', NULL, 'BUSINESS_TYPE', 'Distributor',      'distributor'),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', NULL, 'BUSINESS_TYPE', 'Professional',     'professional');

-- Industries (under Business Types that plausibly have them)
INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'INDUSTRY', 'Beauty',    'beauty'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'INDUSTRY', 'Legal',     'legal'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'INDUSTRY', 'Printing',  'printing'),
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'INDUSTRY', 'Beauty',    'beauty'),
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'INDUSTRY', 'Beauty',    'beauty'),
  ('20000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'INDUSTRY', 'Cosmetics', 'cosmetics');

-- Specialties
INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'SPECIALTY', 'Hair Coloring',    'hair-coloring'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'SPECIALTY', 'Balayage',         'balayage'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'SPECIALTY', 'Family Law',       'family-law'),
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'SPECIALTY', 'Printer Parts',    'printer-parts'),
  ('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', 'SPECIALTY', 'Hair Care Products','hair-care-products'),
  ('30000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'SPECIALTY', 'Salon Equipment',  'salon-equipment');

-- Sub-specialties (optional level; one example)
INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug) VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'SUB_SPECIALTY', 'Balayage on Dark Hair', 'balayage-dark-hair');

-- Persian translations (first-class)
INSERT INTO taxonomy_node_translations (node_id, locale, name) VALUES
  ('10000000-0000-0000-0000-000000000001', 'fa', 'خدمات‌دهنده'),
  ('10000000-0000-0000-0000-000000000003', 'fa', 'عمده‌فروش'),
  ('10000000-0000-0000-0000-000000000004', 'fa', 'تولیدکننده'),
  ('20000000-0000-0000-0000-000000000001', 'fa', 'زیبایی'),
  ('20000000-0000-0000-0000-000000000003', 'fa', 'چاپ و تبلیغات'),
  ('30000000-0000-0000-0000-000000000001', 'fa', 'رنگ و لایت'),
  ('30000000-0000-0000-0000-000000000002', 'fa', 'بالیاژ');

-- Persian/English aliases (alias_norm already normalized: Arabic→Persian chars,
-- ZWNJ kept as U+200C, Arabic yeh/kaf mapped to Persian forms).
INSERT INTO taxonomy_node_aliases (node_id, alias, alias_norm, locale) VALUES
  ('20000000-0000-0000-0000-000000000001', 'آرایشگاه زنانه', 'آرایشگاه زنانه', 'fa'),
  ('20000000-0000-0000-0000-000000000001', 'سالن زیبایی',    'سالن زیبایی',    'fa'),
  ('20000000-0000-0000-0000-000000000001', 'Beauty Salon',   'beauty salon',   'en'),
  ('20000000-0000-0000-0000-000000000001', 'Hair Salon',     'hair salon',     'en'),
  ('30000000-0000-0000-0000-000000000001', 'رنگ مو',         'رنگ مو',         'fa'),
  ('30000000-0000-0000-0000-000000000001', 'رنگ و لایت',     'رنگ و لایت',     'fa'),
  ('30000000-0000-0000-0000-000000000002', 'بالیاژ',         'بالیاژ',         'fa'),
  ('10000000-0000-0000-0000-000000000003', 'عمده فروشی',     'عمده فروشی',     'fa');

-- Location aliases (Persian ↔ English, common variants)
INSERT INTO location_aliases (alias, alias_norm, locale, country, province, city) VALUES
  ('شیراز',   'شیراز',   'fa', 'IR', 'Fars',     'Shiraz'),
  ('تهران',   'تهران',   'fa', 'IR', 'Tehran',   'Tehran'),
  ('مشهد',    'مشهد',    'fa', 'IR', 'Khorasan', 'Mashhad'),
  ('Teheran', 'teheran', 'en', 'IR', 'Tehran',   'Tehran');

COMMIT;

-- Down-seed:
-- BEGIN;
-- DELETE FROM location_aliases WHERE country = 'IR';
-- DELETE FROM taxonomy_node_aliases WHERE node_id LIKE '1%' OR node_id LIKE '2%' OR node_id LIKE '3%';
-- DELETE FROM taxonomy_node_translations WHERE node_id LIKE '1%' OR node_id LIKE '2%' OR node_id LIKE '3%';
-- DELETE FROM taxonomy_nodes WHERE tenant_id = '00000000-0000-0000-0000-000000000001';
-- DELETE FROM users  WHERE tenant_id = '00000000-0000-0000-0000-000000000001';
-- DELETE FROM tenants WHERE id      = '00000000-0000-0000-0000-000000000001';
-- COMMIT;
