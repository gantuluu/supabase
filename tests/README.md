# Tests

## Current automated coverage

Deno tests cover:
- HMAC-SHA256 output against a known test vector.
- Signature equality/mismatch behavior.
- Accepted Duitku callback result codes.

GitHub Actions also runs Deno lint and type checks for both Edge Functions.

## Important coverage gaps

The current tests do not simulate the full Duitku HTTP exchange, Supabase PostgREST, concurrent invoice requests, or PostgreSQL RLS/RPC behavior. Those require integration tests against a disposable local Supabase stack and a controlled Duitku sandbox/mock server.

Do not treat a passing static test suite as proof that a live payment flow has been tested.
