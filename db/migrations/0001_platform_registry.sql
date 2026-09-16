-- 0001 - Schema platform e registro delle migrazioni di piattaforma (ADR-0014 §14.5).
--
-- Il runner crea lo stesso registro prima di applicare qualsiasi file (DDL identico in
-- db/runner/runner.js, verificato dai test): qui viene dichiarato perche' faccia parte della
-- storia versionata della piattaforma. Idempotente: su un registro gia' presente non cambia nulla.
--
-- Proprieta': resta all'amministratore che esegue il runner. Il passaggio a platform_admin
-- (ADR-0014 §14.1) arriva con la migrazione di utenti e permessi.

create schema if not exists platform;

create table if not exists platform.migrations (
  name       text primary key check (name ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*\.sql$'),
  checksum   text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);

comment on schema platform is
  'Infrastruttura di piattaforma ComfortService: registro delle migrazioni (ADR-0014).';

comment on table platform.migrations is
  'Migrazioni di piattaforma applicate dal runner di ComfortPlatform: nome del file, sha256 del contenuto, data.';
