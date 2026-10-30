# Supabase Project

Repository for Supabase database migrations, Edge Functions, seed data, and local development configuration.

## Project Structure

```text
.
├── .gitignore
├── README.md
└── supabase/
    ├── migrations/
    │   └── 20261031000000_create_duitku_transactions.sql
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

## Database

### `public.duitku_transactions`

The migration creates a transaction ledger for Duitku POP.

| Column | Purpose |
| --- | --- |
| `id` | Internal transaction UUID |
| `user_id` | Authenticated Supabase user who initiated payment |
| `merchant_order_id` | Unique server-generated Duitku order ID |
| `merchant_code` | Duitku merchant code used for the invoice |
| `amount`, `currency` | Amount in IDR |
| `product_details` | Description sent to Duitku |
| `customer_email`, `customer_phone` | Customer contact details |
| `payment_method` | Optional Duitku payment method |
| `status` | `pending`, `paid`, `failed`, or `expired` |
| `duitku_reference`, `payment_url` | Duitku invoice reference and checkout URL |
| `duitku_status_code`, `duitku_status_message` | Create Invoice response metadata |
| `callback_result_code`, `callback_reference`, `callback_payload` | Verified callback data |
| `paid_at`, `expires_at`, `failure_reason` | Payment lifecycle timestamps and failure reason |
| `created_at`, `updated_at` | Audit timestamps |

RLS is enabled. Authenticated users can only select rows where `user_id = auth.uid()`. Direct insert, update, and delete privileges are revoked from `anon` and `authenticated`; Edge Functions write with a backend secret.

Apply the migration to the linked project:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

For local development, use:

```bash
supabase start
supabase db reset
```

**Data API note:** Supabase no longer automatically exposes newly created public tables to the Data API on new projects. If the Edge Functions use PostgREST (as implemented here), ensure the `public` schema is enabled in **Project Settings → API → Exposed schemas**. Do not grant public write access to this table; RLS and the grants in the migration intentionally limit client access to SELECT only.

## Edge Functions

### `duitku-create-invoice`

Creates and stores a Duitku POP invoice.

- Requires a signed-in Supabase user JWT (`verify_jwt = true`) and independently verifies that token with Supabase Auth.
- Generates `merchantOrderId` on the server; clients must not send their own order ID.
- Creates a `pending` transaction row before calling Duitku.
- Uses the sandbox endpoint by default. Set `DUITKU_ENV=production` for production.
- Accepts `paymentAmount`, `productDetails`, `email`, and optional `phoneNumber`, `paymentMethod`, `expiryPeriod`.
- Checks Duitku HTTP success and its business `statusCode = "00"`, plus a valid `reference` and HTTPS `paymentUrl`.
- Saves the Duitku reference, checkout URL, and response status before returning checkout details.

Example request:

```json
{
  "paymentAmount": 150000,
  "productDetails": "Order payment",
  "email": "customer@example.com",
  "paymentMethod": "SP",
  "expiryPeriod": 60
}
```

Example success response:

```json
{
  "success": true,
  "data": {
    "transactionId": "<uuid>",
    "merchantOrderId": "TRX-<server-generated-id>",
    "reference": "<duitku-reference>",
    "paymentUrl": "https://...",
    "amount": 150000,
    "currency": "IDR",
    "status": "pending"
  }
}
```

### `duitku-callback`

Receives Duitku POP payment notifications.

- `verify_jwt = false` because Duitku does not send a Supabase user JWT.
- Accepts the documented `application/x-www-form-urlencoded` callback format.
- Verifies the HMAC-SHA256 signature, merchant code, merchant order ID, amount, and (when already stored) Duitku reference.
- Marks a transaction `paid` only when `resultCode = "00"`; every other result code is treated as non-success.
- Persists callback fields before acknowledging with plain-text `OK`.
- Handles duplicate callbacks without downgrading a transaction already marked `paid`. Failed callbacks cannot overwrite a paid state; a later verified success can transition a failed transaction to paid.

## Environment Variables / Secrets

Configure these in **Edge Functions → Secrets** or through the Supabase CLI. Never commit real values.

| Variable | Required | Description |
| --- | --- | --- |
| `DUITKU_MERCHANT_CODE` | Yes | Duitku merchant code |
| `DUITKU_MERCHANT_KEY` | Yes | Duitku HMAC merchant key |
| `DUITKU_CALLBACK_URL` | Yes | Public URL of the deployed `duitku-callback` function |
| `DUITKU_RETURN_URL` | Yes | Customer redirect URL after payment |
| `DUITKU_ENV` | No | `sandbox` (default) or `production` |
| `SUPABASE_URL` | Yes | Supabase project URL (provided by hosted Edge Functions) |
| `SUPABASE_PUBLISHABLE_KEYS` or `SUPABASE_ANON_KEY` | Yes | Used to validate the user's access token |
| `SUPABASE_SECRET_KEYS` or `SUPABASE_SERVICE_ROLE_KEY` | Yes | Backend-only key for transaction persistence |

The functions support the current default `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` JSON environment variables and legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` variables.

For local development, put the values in `supabase/functions/.env`; this path is ignored by Git.

## Deploy Edge Functions

```bash
supabase functions deploy duitku-create-invoice
supabase functions deploy duitku-callback
```

Configure the callback URL as:

```text
https://<project-ref>.supabase.co/functions/v1/duitku-callback
```

## Important Integration Boundary

There is not yet an application order/catalog table in this repository. Therefore the current invoice endpoint accepts the requested amount and product description from the authenticated client, then records those values before creating the Duitku invoice. The callback is reconciled against that stored transaction amount. This prevents callback amount tampering and prevents clients from changing an existing transaction, but it does **not** prove that the initial amount matches a real cart/order total. Before accepting production orders, derive the amount and description from a trusted order record in the application's database.

Do not expose Duitku merchant keys or Supabase secret/service-role keys in browser code.

## References

- [Duitku POP API documentation](https://docs.duitku.com/pop/en/)
- [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Data API security](https://supabase.com/docs/guides/api/securing-your-api)
