# Database Design

## Tables

### `duitku_payment_orders`

Trusted order snapshot. The upstream trusted backend writes this row only after calculating the final amount from authoritative application data.

- `user_id` binds the order to a Supabase Auth user.
- `source_order_id` uniquely identifies the canonical order in the upstream application and prevents duplicate payment snapshots.
- `amount` is a positive integer in IDR.
- `currency` is constrained to IDR for this integration.
- `product_details` and customer fields are copied into the payment attempt.
- `status` tracks pending, paid, cancelled, and expired.
- `expires_at` is the authoritative order deadline.

### `duitku_transactions`

Stores every invoice attempt and its provider/callback metadata. Multiple historical failed or expired attempts may exist for an order. A partial unique index permits at most one pending transaction per non-null order ID. Multiple paid attempts remain representable so delayed provider notifications can be recorded and reconciled.

## Access control

- RLS is enabled on both tables.
- Authenticated users can select only their own rows.
- `anon` and `authenticated` have no direct write privileges.
- Backend functions use a secret/service-role key.
- `apply_duitku_callback` is a SECURITY DEFINER function with an empty search path and execute permission restricted to `service_role`.

## Account deletion and retention

Both order and transaction records reference `auth.users` with `ON DELETE RESTRICT`. This prevents accidental deletion of financial history when an Auth user is removed. Account deletion must follow an approved retention policy and anonymize personal fields where legally permitted; do not cascade-delete payment history. The exact retention period and anonymization fields must be confirmed against the application's legal and accounting requirements before implementation.

## Atomic callback

The callback Edge Function verifies the provider HMAC before invoking the database RPC. The RPC locks the order first and then the matching transaction row, checks merchant code, amount, result code, and the optional reference when supplied, then updates the transaction and order together. A database error rolls back both changes.

## Lifecycle

- Invoice created: transaction `pending`, order `pending`.
- Provider success (`00`): transaction and order become `paid`.
- Verified status `01`: transaction remains `pending` until Duitku reports a final state.
- Verified status `02`: transaction becomes `failed`; order remains `pending` so a later attempt can be created.
- Order cancellation/expiry is owned by the trusted application backend or a separately reviewed scheduled process.
- A late verified provider success is recorded as `paid`; the RPC returns a `late_payment` indicator when the order had already been cancelled or expired.

## Expiry routine

`public.expire_pending_duitku_payment_orders(p_as_of)` expires pending orders whose trusted `expires_at` has passed and their pending invoice attempts in one database transaction. It is executable only by `service_role`. The `duitku-expire-orders` Edge Function protects access with a separate shared secret; an external scheduler must invoke it. No scheduler is configured by this repository.

The expiry routine and callback routine lock the order before transaction rows, preserving a consistent lock order. A verified late success may still transition an expired order and transaction to paid, and is flagged for reconciliation.
