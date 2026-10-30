# Edge Functions

## duitku-create-invoice

**Method:** POST  
**JWT verification:** enabled in `supabase/config.toml`.

Request:

```json
{
  "orderId": "00000000-0000-4000-8000-000000000000",
  "paymentMethod": "SP"
}
```

Only `orderId` is required. `paymentMethod` is optional. Amount, currency, product description, email, phone, and expiration are read from the trusted `duitku_payment_orders` record.

Responses:
- `200`: invoice created or an existing pending invoice safely reused.
- `400`: malformed request.
- `401`: missing/invalid user token.
- `404`: order not found or not owned by the user.
- `409`: order is not payable, already paid, or an attempt is already in progress.
- `422`: trusted order data is invalid.
- `502`: Duitku rejected the request or the provider outcome needs reconciliation.

Network timeouts, provider 5xx, malformed success responses, and persistence failures must not trigger an automatic second invoice. Reconcile the merchant order ID with Duitku first.

## duitku-callback

**Method:** POST  
**JWT verification:** disabled because Duitku does not provide a Supabase user JWT. The handler accepts the current documented HMAC-SHA256 callback signature and the legacy MD5 signature implemented by Duitku's official PHP POP library. Both are followed by an independent status query before settlement.

The callback accepts URL-encoded form fields. It validates merchant code, amount, merchant order ID, result code, and signature; the optional callback reference is cross-checked when supplied.

Before changing local state, it calls the official POP transaction-status endpoint at `https://api-sandbox.duitku.com/api/merchant/transactionStatus` or `https://api-prod.duitku.com/api/merchant/transactionStatus`. The request signature is MD5 of `merchantCode + merchantOrderId + merchantKey`, as implemented by Duitku's official `Pop::transactionStatus` library method. The response's merchant order ID and amount must match. `statusCode = 00` is paid, `01` is pending (the callback receives HTTP 503 so it can be retried), and `02` is cancelled/failed. Unknown statuses are not settled.

Duitku's POP callback page itself has an inconsistency: its parameter table lists `01` as failed, while its result-code table lists `02` as failed. The independent POP status response is used as the settlement source of truth.

After independent provider verification, the callback calls `rpc/apply_duitku_callback`; transaction/order reconciliation is atomic inside PostgreSQL.

## duitku-expire-orders

**Method:** POST  
**JWT verification:** disabled; access requires the high-entropy `PAYMENT_EXPIRY_SECRET` in the `x-expiry-secret` header.

Calls `rpc/expire_pending_duitku_payment_orders` to expire pending orders whose trusted deadline has passed, along with their pending invoice attempts. Invoke it from an external scheduler at an appropriate interval. No schedule is installed by this repository.

## Shared code and tests

Shared HMAC, comparison, and result-code helpers live in `supabase/functions/_shared/duitku.ts`. Their Deno tests are in `supabase/functions/_shared/duitku.test.ts`.
