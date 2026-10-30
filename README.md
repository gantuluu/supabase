# Supabase Infrastructure Repository

This repository is the version-controlled source of truth for Supabase database migrations, Edge Functions, local configuration, tests, and operational documentation.

**This repository does not contain production database records or secrets.** Live data remains in the Supabase database. Migrations and Edge Functions are stored here and are not applied or deployed automatically by this repository.

## Repository Structure

```text
.
├── .github/workflows/validate.yml
├── database/
│   ├── README.md
│   └── types/
│       └── README.md
├── docs/
│   ├── architecture.md
│   ├── database.md
│   ├── deployment.md
│   └── edge-functions.md
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   ├── functions/
│   │   ├── _shared/
│   │   ├── duitku-create-invoice/
│   │   ├── duitku-callback/
│   │   └── duitku-expire-orders/
│   └── seed.sql
├── tests/
│   └── README.md
└── README.md
```

## Current Database Objects

### `public.duitku_payment_orders`

A trusted order ledger. A trusted application backend must create these records after validating the cart/order and calculating the final amount. Browser clients must never choose the authoritative amount or write order rows directly.

| Column | Purpose |
| --- | --- |
| `id` | Order UUID |
| `user_id` | Owning Supabase Auth user |
| `source_order_id` | Unique ID of the canonical order in the upstream application |
| `amount`, `currency` | Trusted amount in IDR |
| `product_details` | Invoice description |
| `customer_email`, `customer_phone` | Trusted customer contact |
| `status` | `pending`, `paid`, `cancelled`, or `expired` |
| `expires_at`, `paid_at` | Order lifecycle timestamps |
| `created_at`, `updated_at` | Audit timestamps |

Authenticated users can only read their own order rows. Insert/update/delete privileges are not granted to `anon` or `authenticated`.

### `public.duitku_transactions`

A payment-attempt ledger for Duitku POP.

| Column | Purpose |
| --- | --- |
| `id` | Internal transaction UUID |
| `order_id` | Associated trusted order; nullable only for legacy rows |
| `user_id` | Authenticated owner |
| `merchant_order_id` | Unique server-generated Duitku order ID |
| `merchant_code`, `amount`, `currency` | Merchant and payment amount |
| `product_details`, `customer_email`, `customer_phone` | Invoice details copied from trusted order |
| `payment_method` | Optional Duitku payment method |
| `status` | `pending`, `paid`, `failed`, or `expired` |
| `duitku_reference`, `payment_url` | Duitku reference and checkout URL |
| `duitku_status_code`, `duitku_status_message` | Create Invoice response metadata |
| `callback_result_code`, `callback_reference`, `callback_payload` | Verified callback data |
| `paid_at`, `expires_at`, `failure_reason` | Payment lifecycle metadata |
| `created_at`, `updated_at` | Audit timestamps |

Authenticated users can only read their own transaction rows. Client-side writes are revoked. Service-role access is restricted to backend functions.

**Data API requirement:** the `public` schema must be enabled in the target project's Exposed schemas because these Edge Functions use Supabase PostgREST for table and RPC access. Keep table grants and RLS restrictive; exposing a schema does not require granting client write access.

## Database Migrations

Migrations are the authoritative schema history. Do not maintain a second editable copy of table definitions.

Current migrations:

1. `20261031000000_create_duitku_transactions.sql`
2. `20261031010000_add_trusted_payment_orders.sql`

Apply migrations only after reviewing the target project and obtaining explicit deployment authorization:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

The commands above are documentation only; no database has been linked or changed as part of the repository remediation.

## Edge Functions

### `duitku-create-invoice`

Creates a Duitku POP invoice from a trusted `duitku_payment_orders` row.

Request body:

```json
{
  "orderId": "00000000-0000-4000-8000-000000000000",
  "paymentMethod": "SP"
}
```

- Requires a signed-in Supabase user JWT.
- Confirms the order belongs to the authenticated user and is still payable.
- Reads amount, currency, description, email, phone, and expiry from the database.
- Does not accept client-supplied amount, product description, customer email, or expiry.
- Uses a unique pending-order index to prevent concurrent duplicate invoice creation while retaining historical paid/failed attempts.
- Reuses a previously saved pending invoice.
- Keeps ambiguous network/server outcomes pending for reconciliation instead of blindly creating another invoice.
- Uses sandbox by default; set `DUITKU_ENV=production` only when production is approved.

The upstream trusted application backend is responsible for creating one `duitku_payment_orders` row per canonical application order after validating the real cart/order. `source_order_id` is unique to prevent duplicate payment snapshots for the same upstream order. It must use a backend-only key and must not expose that key to a browser.

### `duitku-callback`

Receives Duitku POP payment notifications.

- Public endpoint; `verify_jwt = false` because Duitku does not send a Supabase user JWT.
- Accepts the documented `application/x-www-form-urlencoded` format.
- Verifies the HMAC-SHA256 signature using `merchantCode + amount + merchantOrderId`.
- Validates merchant code, amount, merchant order ID, and supported result code; cross-checks the optional reference when Duitku supplies it.
- Rejects duplicate parameter names and invalid signatures.
- Calls `public.apply_duitku_callback` to reconcile the transaction and order atomically.
- Returns plain-text `OK` only after a successful reconciliation or confirmed duplicate.

Duitku's POP callback documentation contains inconsistent failure-code references: the parameter table lists `01`, while the result-code table lists `02`. The implementation accepts both as failure and treats only `00` as paid. Unknown codes are rejected without changing transaction state.

### `duitku-expire-orders`

Expires pending orders and their pending invoice attempts through an atomic database RPC. The endpoint has `verify_jwt = false` and requires the `x-expiry-secret` header matching the `PAYMENT_EXPIRY_SECRET` secret. Invoke it from a separately configured external scheduler; this repository does not configure or run a scheduler.

## Secrets and Environment

Never commit real keys, tokens, passwords, or production environment files.

Required Edge Function secrets:

| Variable | Required | Description |
| --- | --- | --- |
| `DUITKU_MERCHANT_CODE` | Yes | Duitku merchant code |
| `DUITKU_MERCHANT_KEY` | Yes | Duitku HMAC merchant key |
| `DUITKU_CALLBACK_URL` | Yes | Public HTTPS callback URL |
| `DUITKU_RETURN_URL` | Yes | Customer return URL (HTTPS) |
| `DUITKU_ENV` | No | `sandbox` (default) or `production` |
| `PAYMENT_EXPIRY_SECRET` | For expiry handler | High-entropy secret used by the external scheduler |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEYS` or `SUPABASE_ANON_KEY` | Yes | Validates the user access token |
| `SUPABASE_SECRET_KEYS` or `SUPABASE_SERVICE_ROLE_KEY` | Yes | Backend-only database access |

The current key-set variables are read from a JSON object containing a `default` property. Legacy anon/service-role variables are supported for compatibility. Use the Supabase Dashboard or CLI to configure secrets; never store their values in Git.

For local development, copy `supabase/functions/.env.example` to `supabase/functions/.env` and fill it with local test values. The actual `.env` file is ignored by Git.

## Validation

The GitHub Actions workflow runs Deno lint, type checking, and the shared Deno tests. It does not connect to a Supabase project, apply migrations, or deploy functions.

Run locally:

```bash
deno lint supabase/functions
deno check supabase/functions/duitku-create-invoice/index.ts
deno check supabase/functions/duitku-callback/index.ts
deno check supabase/functions/duitku-expire-orders/index.ts
deno test supabase/functions/_shared
```

## Account Deletion and Financial Records

The `user_id` foreign keys use `ON DELETE RESTRICT` intentionally so deleting an Auth user cannot silently erase payment/order audit history. An application account-deletion process must first follow the applicable retention policy and use an approved anonymization workflow for customer PII. Do not change these foreign keys to `CASCADE` without a reviewed financial-record retention decision.

## Security and Operational Boundaries

- Never trust an amount supplied by a browser.
- Never expose Duitku merchant keys or Supabase secret/service-role keys to browser code.
- Do not grant client-side write access to payment or order ledgers.
- A valid callback is the payment-status source of truth; a customer return redirect is not proof of payment.
- Reconcile ambiguous invoice requests before retrying them.
- Review migrations and workflow changes before applying them to any Supabase project.
- Repository commits do not imply that a live database or Edge Function has changed.

## References

- [Duitku POP API documentation](https://docs.duitku.com/pop/en/)
- [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase CLI migrations](https://supabase.com/docs/guides/deployment/database-migrations)
