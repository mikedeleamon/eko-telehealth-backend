-- Admin-editable content (task 2.2) — a curated set of prose blocks an admin
-- can update without a developer, per SOW 1.15. Not a general page builder:
-- `key` is a fixed slug the app already renders somewhere (AboutUsScreen,
-- and the two new Terms/Privacy screens) — the editor updates text, not
-- structure.
--
-- Idempotent — safe to run repeatedly and safe on a database freshly created
-- from the current schema.ts.
--
--   psql "$DATABASE_URL" -f migrations/0009_content_blocks.sql

CREATE TABLE IF NOT EXISTS content_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO content_blocks (key, title, body)
SELECT 'about_mission', 'Our Mission',
  'Eko Telehealth connects patients with licensed, verified doctors for video, clinic, and home visits — bringing quality healthcare within reach, wherever you are.'
WHERE NOT EXISTS (SELECT 1 FROM content_blocks WHERE key = 'about_mission');

INSERT INTO content_blocks (key, title, body)
SELECT 'about_contact', 'Contact Us',
  'Have a question or need help? Reach our support team at support@ekotelehealth.com, or use "Report a Problem" in Settings to file a trackable request.'
WHERE NOT EXISTS (SELECT 1 FROM content_blocks WHERE key = 'about_contact');

INSERT INTO content_blocks (key, title, body)
SELECT 'terms_of_service', 'Terms of Service',
  'By using Eko Telehealth, you agree to receive care from licensed providers subject to their own professional obligations, to provide accurate information during registration and consultations, and to use the platform only for its intended purpose of arranging and conducting telehealth visits. Eko Telehealth is a marketplace connecting patients and providers; it does not itself practice medicine. Full terms are available on request from support@ekotelehealth.com.'
WHERE NOT EXISTS (SELECT 1 FROM content_blocks WHERE key = 'terms_of_service');

INSERT INTO content_blocks (key, title, body)
SELECT 'privacy_policy', 'Privacy Policy',
  'Eko Telehealth collects the information needed to provide care: your account details, appointment history, and any medical information you or your provider add to your record. This information is shared only with providers you consult and is never sold. You can request a copy or deletion of your data at any time via support@ekotelehealth.com.'
WHERE NOT EXISTS (SELECT 1 FROM content_blocks WHERE key = 'privacy_policy');
