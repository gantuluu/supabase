# Deployment and Operations

This repository does not automatically connect to or modify a Supabase project.

## Review before deployment

1. Review every migration and Edge Function change.
2. Confirm the exact Supabase project reference and that the operator has access.
3. Configure required Edge Function secrets outside GitHub.
4. Confirm the trusted upstream backend creates valid `duitku_payment_orders` rows.
5. Run local tests and inspect CI results.
6. Obtain explicit authorization before applying migrations or deploying functions.

## Manual commands

After a separately approved project is selected and linked:

```bash
supabase link --project-ref <project-ref>
supabase db push
supabase functions deploy duitku-create-invoice
supabase functions deploy duitku-callback
supabase functions deploy duitku-expire-orders
```

These commands are documentation only. They are not run by the GitHub workflow and were not executed during this remediation. Configure `PAYMENT_EXPIRY_SECRET` as an Edge Function secret before enabling an external scheduler for `duitku-expire-orders`.

## Secret management

Set secrets through Supabase Dashboard or CLI. Never commit real values to the repository, GitHub Actions logs, issue comments, or pull requests.

Required variables are listed in the root README and in `supabase/functions/.env.example` (placeholder values only).
