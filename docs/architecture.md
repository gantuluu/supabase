# Architecture

## Source of truth

GitHub is the source of truth for schema migrations, Edge Function source, local configuration, tests, and operational documentation. The live Supabase database remains the runtime store for user and transaction records.

No CI workflow in this repository applies migrations or deploys Edge Functions.

## Duitku payment flow

1. A trusted application backend validates the user's cart/order and calculates the final amount.
2. That backend inserts a `payment_orders` row using a backend-only Supabase key. The browser must not choose or write the authoritative amount.
3. The authenticated user calls `duitku-create-invoice` with the order UUID.
4. The function verifies the user's JWT, checks order ownership and payable state, and reads the amount and customer details from `payment_orders`.
5. The function creates one pending Duitku invoice attempt for the order. A database partial unique index prevents concurrent pending attempts while preserving paid attempts for reconciliation.
6. Duitku sends its signed callback to `duitku-callback`.
7. The callback verifies the signature and invokes `public.apply_duitku_callback`.
8. The database function locks the order before its transaction row and updates the payment attempt and order in one database transaction.

## Trust boundaries

- Browser: may request an invoice for an order owned by the current user; cannot set the authoritative amount.
- Trusted application backend: may create trusted order rows after validating catalog/cart/discount/shipping/tax rules.
- Invoice Edge Function: validates identity and order ownership; holds backend credentials.
- Duitku: callback is unauthenticated at the Supabase JWT layer, but must pass merchant HMAC validation.
- Database RPCs: executable only by `service_role`; perform atomic payment/order reconciliation and expiry.

## Ambiguous outcomes

A network timeout or provider 5xx can occur after Duitku has accepted an invoice request. The function keeps that transaction pending and blocks another invoice attempt until reconciliation. This favors avoiding duplicate charges over automatic retry. An operator must verify the transaction with Duitku before deciding whether to retry or expire it.
