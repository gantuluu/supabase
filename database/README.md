# Database Artifacts

The authoritative database schema history is stored in `supabase/migrations/`.

This directory is reserved for database design notes and generated reference material that does not replace migration files. Do not maintain hand-edited duplicate CREATE TABLE, policy, trigger, or index definitions here; duplicated SQL can drift from the migration history.

## Rules

- Every schema change must be a new timestamped migration.
- Do not rewrite an already-applied migration to change a live database.
- Keep RLS policies, grants, indexes, triggers, and database functions in migrations.
- Keep seed data deterministic and free of production/customer data.
- Generated TypeScript database types must be traceable to the migration state from which they were generated.
- Live records are not stored in GitHub.
