# Supabase Project

Repository for Supabase database migrations, Edge Functions, seed data, and local development configuration.

## Project Structure

```text
.
├── README.md
└── supabase/
    ├── migrations/
    ├── functions/
    ├── seed.sql
    └── config.toml
```

## Requirements

- [Supabase CLI](https://supabase.com/docs/guides/cli)
- Docker-compatible runtime for the local Supabase stack

## Local Development

Initialize the local Supabase services:

```bash
supabase start
```

Apply migrations and seed data to the local database:

```bash
supabase db reset
```

Stop local services:

```bash
supabase stop
```

## Directory Guide

- `supabase/migrations/` — version-controlled SQL schema changes. Create migration files with `supabase migration new <migration_name>`.
- `supabase/functions/` — Supabase Edge Functions.
- `supabase/seed.sql` — optional development and test seed data.
- `supabase/config.toml` — local Supabase CLI configuration.

## Notes

- No database schema, migration, seed records, or Edge Function has been added yet.
- Keep secrets out of committed files. Use environment variables for sensitive configuration.
