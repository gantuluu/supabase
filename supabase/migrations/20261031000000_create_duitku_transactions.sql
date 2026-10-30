-- Duitku POP transaction ledger.
create table if not exists public.duitku_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  merchant_order_id text not null unique,
  merchant_code text not null,
  amount bigint not null check (amount > 0),
  currency text not null default 'IDR' check (currency = 'IDR'),
  product_details text not null,
  customer_email text not null,
  customer_phone text,
  payment_method text,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'expired')),
  duitku_reference text unique,
  payment_url text,
  duitku_status_code text,
  duitku_status_message text,
  callback_result_code text,
  callback_reference text,
  callback_payload jsonb,
  paid_at timestamptz,
  expires_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists duitku_transactions_user_created_idx
  on public.duitku_transactions (user_id, created_at desc);
create index if not exists duitku_transactions_status_created_idx
  on public.duitku_transactions (status, created_at desc);

alter table public.duitku_transactions enable row level security;

drop policy if exists "Users can read their own Duitku transactions"
  on public.duitku_transactions;
create policy "Users can read their own Duitku transactions"
  on public.duitku_transactions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.duitku_transactions from anon, authenticated;
grant select on table public.duitku_transactions to authenticated;
