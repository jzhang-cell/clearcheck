-- ═══════════════════════════════════════════════════════════════════
-- ClearCheck V3 — Seed SOC 2 Privacy (P) Trust Services Criteria
-- Migration: 0012_tscs_privacy_set.sql
-- ═══════════════════════════════════════════════════════════════════
--
-- The prod tscs table held only Security/Availability/PI/Confidentiality
-- criteria — the Privacy (P*) category was never seeded. So Privacy (PR.*)
-- controls linked to TSCs that don't exist in the DB → control_tscs got no
-- rows → ingest/refine/run-audit threw "Control has no linked TSCs" and every
-- Privacy control failed (Batch Test 02, ADR-014 / BATCH_TEST_02 §3c).
--
-- Source of truth: AICPA "2017 Trust Services Criteria (with revised points of
-- focus — 2022)", Privacy section (P1.0–P8.1). Descriptions are VERBATIM. The
-- audit pipeline only reads tsc_code + description (points_of_focus is not used
-- by ingest/refine/run-audit), so points_of_focus is left NULL here.
--
-- ids are explicit and deterministic (uuid5) so they can be synced into the
-- Airtable TSC Criteria table's Supabase_TSC_ID without a round-trip read.
-- Idempotent upsert by tsc_code (no deletes → no FK impact).

insert into tscs (id, tsc_code, trust_principle, common_criteria_category, description) values
  ('ad081882-cfc5-5756-b13c-761539271ebb', 'P1.1', 'Privacy', 'P1 - Notice and Communication of Objectives Related to Privacy', 'The entity provides notice to data subjects about its privacy practices to meet the entity’s objectives related to privacy. The notice is updated and communicated to data subjects in a timely manner for changes to the entity’s privacy practices, including changes in the use of personal information, to meet the entity’s objectives related to privacy.'),
  ('7a5c5d09-5137-5f61-9701-f81e40c5bba8', 'P2.1', 'Privacy', 'P2 - Choice and Consent', 'The entity communicates choices available regarding the collection, use, retention, disclosure, and disposal of personal information to the data subjects and the consequences, if any, of each choice. Explicit consent for the collection, use, retention, disclosure, and disposal of personal information is obtained from data subjects or other authorized persons, if required. Such consent is obtained only for the intended purpose of the information to meet the entity’s objectives related to privacy. The entity’s basis for determining implicit consent for the collection, use, retention, disclosure, and disposal of personal information is documented.'),
  ('c46acb79-cb60-5d41-99e9-b7e2f6eaf965', 'P3.1', 'Privacy', 'P3 - Collection', 'Personal information is collected consistent with the entity’s objectives related to privacy.'),
  ('d4c9f126-c724-5735-88df-8ebef3707f19', 'P3.2', 'Privacy', 'P3 - Collection', 'For information requiring explicit consent, the entity communicates the need for such consent as well as the consequences of a failure to provide consent for the request for personal information and obtains the consent prior to the collection of the information to meet the entity’s objectives related to privacy.'),
  ('172623b0-c6b8-57c3-bc53-2df6b75ada20', 'P4.1', 'Privacy', 'P4 - Use, Retention, and Disposal', 'The entity limits the use of personal information to the purposes identified in the entity’s objectives related to privacy.'),
  ('56b9b139-1044-592c-a51f-9027f2e843b2', 'P4.2', 'Privacy', 'P4 - Use, Retention, and Disposal', 'The entity retains personal information consistent with the entity’s objectives related to privacy.'),
  ('5997d76e-096a-501c-806f-999fecca240c', 'P4.3', 'Privacy', 'P4 - Use, Retention, and Disposal', 'The entity securely disposes of personal information to meet the entity’s objectives related to privacy.'),
  ('3b26d39f-05ee-5c0e-9652-500879fa27ec', 'P5.1', 'Privacy', 'P5 - Access', 'The entity grants identified and authenticated data subjects the ability to access their stored personal information for review and, upon request, provides physical or electronic copies of that information to data subjects to meet the entity’s objectives related to privacy. If access is denied, data subjects are informed of the denial and reason for such denial, as required, to meet the entity’s objectives related to privacy.'),
  ('6263878d-7a61-5967-9b08-661ca8ccadc6', 'P5.2', 'Privacy', 'P5 - Access', 'The entity corrects, amends, or appends personal information based on information provided by data subjects and communicates such information to third parties, as committed or required, to meet the entity’s objectives related to privacy. If a request for correction is denied, data subjects are informed of the denial and reason for such denial to meet the entity’s objectives related to privacy.'),
  ('1614b921-341e-5fe3-9d95-008345aba661', 'P6.1', 'Privacy', 'P6 - Disclosure and Notification', 'The entity discloses personal information to third parties with the explicit consent of data subjects and such consent is obtained prior to disclosure to meet the entity’s objectives related to privacy.'),
  ('e9f33776-5bf2-5cee-8d38-696dca016b0c', 'P6.2', 'Privacy', 'P6 - Disclosure and Notification', 'The entity creates and retains a complete, accurate, and timely record of authorized disclosures of personal information to meet the entity’s objectives related to privacy.'),
  ('7b96bac4-5e11-56e3-99dc-8e11286a5c90', 'P6.3', 'Privacy', 'P6 - Disclosure and Notification', 'The entity creates and retains a complete, accurate, and timely record of detected or reported unauthorized disclosures (including breaches) of personal information to meet the entity’s objectives related to privacy.'),
  ('44f7fce5-d920-5dcb-8fdb-b67e90f09cf9', 'P6.4', 'Privacy', 'P6 - Disclosure and Notification', 'The entity obtains privacy commitments from vendors and other third parties who have access to personal information to meet the entity’s objectives related to privacy. The entity assesses those parties’ compliance on a periodic and as-needed basis and takes corrective action, if necessary.'),
  ('a588b0bd-b401-54fb-a463-039e5031c7ca', 'P6.5', 'Privacy', 'P6 - Disclosure and Notification', 'The entity obtains commitments from vendors and other third parties with access to personal information to notify the entity in the event of actual or suspected unauthorized disclosures of personal information. Such notifications are reported to appropriate personnel and acted on in accordance with established incident-response procedures to meet the entity’s objectives related to privacy.'),
  ('e23e0c6d-cb3d-5ed5-962e-388e1c224031', 'P6.6', 'Privacy', 'P6 - Disclosure and Notification', 'The entity provides notification of breaches and incidents to affected data subjects, regulators, and others to meet the entity’s objectives related to privacy.'),
  ('0156ef52-2a04-57a5-a39a-cab431b4e999', 'P6.7', 'Privacy', 'P6 - Disclosure and Notification', 'The entity provides data subjects with an accounting of the personal information held and disclosure of the data subjects’ personal information, upon the data subjects’ request, to meet the entity’s objectives related to privacy.'),
  ('16dc6928-a6a5-5caa-9833-10a4a8e3c8ce', 'P7.1', 'Privacy', 'P7 - Quality', 'The entity collects and maintains accurate, up-to-date, complete, and relevant personal information to meet the entity’s objectives related to privacy.'),
  ('fe1d6c43-6b98-5875-9315-7e65287170f6', 'P8.1', 'Privacy', 'P8 - Monitoring and Enforcement', 'The entity implements a process for receiving, addressing, resolving, and communicating the resolution of inquiries, complaints, and disputes from data subjects and others and periodically monitors compliance to meet the entity’s objectives related to privacy. Corrections and other necessary actions related to identified deficiencies are made or taken in a timely manner.')

on conflict (tsc_code) do update set
  trust_principle          = excluded.trust_principle,
  common_criteria_category = excluded.common_criteria_category,
  description              = excluded.description;
