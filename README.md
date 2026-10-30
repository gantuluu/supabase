# Supabase Project

Repository for Supabase database migrations, Edge Functions, seed data, and local development configuration.

## Project Structure

```text
.
├── README.md
└── supabase/
    ├── migrations/
    ├── functions/
    │   ├── duitku-create-invoice/
    │   │   └── index.ts
    │   └── duitku-callback/
    │       └── index.ts
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

Run the Edge Functions locally:

```bash
supabase functions serve --env-file supabase/functions/.env
```

Apply migrations and seed data to the local database:

```bash
supabase db reset
```

Stop local services:

```bash
supabase stop
```

## Edge Functions

### `duitku-create-invoice`

Creates a Duitku POP invoice using the official Create Invoice endpoint.

- Requires a valid Supabase user JWT (`verify_jwt = true`).
- Uses the sandbox endpoint by default.
- Set `DUITKU_ENV=production` to use the production endpoint.
- The callback and return URLs are configured server-side; clients cannot override them.

Example request body:

```json
{
  "paymentAmount": 150000,
  "merchantOrderId": "ORDER-2026-0001",
  "productDetails": "Order payment",
  "email": "customer@example.com",
  "paymentMethod": "SP",
  "expiryPeriod": 60
}
```

### `duitku-callback`

Receives Duitku POP payment notifications.

- Public gateway access is enabled because Duitku does not send a Supabase user JWT.
- Every callback is verified using Duitku's documented HMAC-SHA256 signature formula.
- A valid callback is acknowledged with plain-text `OK`.
- The current implementation verifies and logs minimal transaction identifiers only. It does not update an order or payment table because this repository does not yet define a transaction schema.

## Duitku Environment Variables

Set these secrets in the Supabase Dashboard or with the Supabase CLI. Never commit real values.

| Variable | Required | Description |
| --- | --- | --- |
| `DUITKU_MERCHANT_CODE` | Yes | Merchant code from Duitku |
| `DUITKU_MERCHANT_KEY` | Yes | Duitku API / merchant key |
| `DUITKU_CALLBACK_URL` | Yes | Public URL of the deployed `duitku-callback` function |
| `DUITKU_RETURN_URL` | Yes | Customer redirect URL after payment |
| `DUITKU_ENV` | No | `sandbox` (default) or `production` |

For local development, put these variables in `supabase/functions/.env` (do not commit that file). For production, configure them as project Edge Function secrets.

## Deploy Edge Functions

Link the CLI to the intended Supabase project, then deploy:

```bash
supabase functions deploy duitku-create-invoice
supabase functions deploy duitku-callback
```

Set the callback URL to:

```text
https://<project-ref>.supabase.co/functions/v1/duitku-callback
```

## Important Production Integration Notes

- Before using invoice creation for real orders, the backend must load the order from the application's database and derive the amount and order ownership from trusted database data. Do not trust a client-supplied amount or order ID as the source of truth.
- Before processing successful callbacks as paid orders, add a transaction table and an idempotent database update keyed by the merchant order ID / Duitku reference. The callback function currently verifies and acknowledges notifications but does not persist payment status.
- Do not expose the Duitku merchant key or Supabase secret key to browser code.

## Directory Guide

- `supabase/migrations/` — version-controlled SQL schema changes. Create migration files with `supabase migration new <migration_name>`.
- `supabase/functions/` — Supabase Edge Functions.
- `supabase/seed.sql` — optional development and test seed data.
- `supabase/config.toml` — local Supabase CLI configuration.

## References

- [Duitku POP API documentation](https://docs.duitku.com/pop/en/)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
