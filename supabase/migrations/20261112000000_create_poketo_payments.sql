-- Poketo sandbox payment integration.
-- The upstream trusted application backend must create payment-order snapshots.
-- Browser clients receive read-only access; Edge Functions use service_role.

create table if not exists public.poketo_payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  source_order_id text not null unique
    check (
      char_length(source_order_id) between 1 and 64
      and source_order_id ~ '^[A-Za-z0-9._:-]+$'
    ),
  amount bigint not null check (amount >= 10000),
  currency text not null default 'IDR' check (currency = 'IDR'),
  title text not null check (char_length(title) between 1 and 255),
  description text,
  customer_name text,
  customer_email text not null,
  customer_phone text,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'cancelled', 'expired')),
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists poketo_payment_orders_user_created_idx
  on public.poketo_payment_orders (user_id, created_at desc);
create index if not exists poketo_payment_orders_status_created_idx
  on public.poketo_payment_orders (status, created_at desc);

alter table public.poketo_payment_orders enable row level security;
drop policy if exists "Users can read their own Poketo payment orders"
  on public.poketo_payment_orders;
create policy "Users can read their own Poketo payment orders"
  on public.poketo_payment_orders
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.poketo_payment_orders from anon, authenticated;
grant select on table public.poketo_payment_orders to authenticated;
grant all on table public.poketo_payment_orders to service_role;

create table if not exists public.poketo_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique
    references public.poketo_payment_orders(id) on delete restrict,
  reference_id text not null unique,
  idempotency_key text not null unique,
  invoice_id text unique,
  amount bigint not null check (amount >= 10000),
  currency text not null default 'IDR' check (currency = 'IDR'),
  environment text not null default 'sandbox' check (environment = 'sandbox'),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'expired', 'cancelled', 'refunded')),
  payment_url text,
  provider_status text,
  provider_payload jsonb,
  paid_at timestamptz,
  expires_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists poketo_transactions_status_created_idx
  on public.poketo_transactions (status, created_at desc);

alter table public.poketo_transactions enable row level security;
drop policy if exists "Users can read their own Poketo transactions"
  on public.poketo_transactions;
create policy "Users can read their own Poketo transactions"
  on public.poketo_transactions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.poketo_payment_orders as o
      where o.id = poketo_transactions.order_id
        and o.user_id = (select auth.uid())
    )
  );

revoke all on table public.poketo_transactions from anon, authenticated;
grant select on table public.poketo_transactions to authenticated;
grant all on table public.poketo_transactions to service_role;

create table if not exists public.poketo_webhook_events (
  event_id text primary key check (char_length(event_id) between 1 and 128),
  event_type text not null,
  invoice_id text,
  reference_id text,
  outcome text not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.poketo_webhook_events enable row level security;
revoke all on table public.poketo_webhook_events from public, anon, authenticated;
grant all on table public.poketo_webhook_events to service_role;

create or replace function public.apply_poketo_webhook_event(
  p_event_id text,
  p_event_type text,
  p_environment text,
  p_invoice_id text,
  p_reference_id text,
  p_amount bigint,
  p_currency text,
  p_invoice_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted_event text;
  v_order record;
  v_tx record;
  v_outcome text := 'ignored';
begin
  if p_event_id is null or p_event_id = '' or char_length(p_event_id) > 128
    or p_event_type is null or p_event_type = '' then
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  insert into public.poketo_webhook_events (
    event_id, event_type, invoice_id, reference_id
  )
  values (p_event_id, p_event_type, p_invoice_id, p_reference_id)
  on conflict (event_id) do nothing
  returning event_id into v_inserted_event;

  if v_inserted_event is null then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if p_event_type not in (
    'invoice.paid', 'invoice.expired', 'invoice.cancelled', 'invoice.refunded'
  ) then
    update public.poketo_webhook_events
    set outcome = 'ignored', processed_at = now()
    where event_id = p_event_id;
    return jsonb_build_object('outcome', 'ignored');
  end if;

  if p_environment <> 'sandbox'
    or p_invoice_id is null or p_invoice_id = ''
    or p_reference_id is null or p_reference_id = ''
    or p_amount is null or p_amount < 10000
    or p_currency <> 'IDR' then
    update public.poketo_webhook_events
    set outcome = 'invalid_event', processed_at = now()
    where event_id = p_event_id;
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  -- Lock order before transaction, consistently with all payment reconciliation.
  select o.id, o.status
  into v_order
  from public.poketo_payment_orders as o
  where o.source_order_id = p_reference_id
  for update;

  if not found then
    update public.poketo_webhook_events
    set outcome = 'not_found', processed_at = now()
    where event_id = p_event_id;
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select t.id, t.invoice_id, t.amount, t.currency, t.status
  into v_tx
  from public.poketo_transactions as t
  where t.order_id = v_order.id
    and t.reference_id = p_reference_id
  for update;

  if not found then
    update public.poketo_webhook_events
    set outcome = 'not_found', processed_at = now()
    where event_id = p_event_id;
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_tx.invoice_id is distinct from p_invoice_id
    or v_tx.amount <> p_amount
    or v_tx.currency <> p_currency then
    update public.poketo_webhook_events
    set outcome = 'transaction_mismatch', processed_at = now()
    where event_id = p_event_id;
    return jsonb_build_object('outcome', 'transaction_mismatch');
  end if;

  if p_event_type = 'invoice.paid' then
    if p_invoice_status <> 'paid' then
      v_outcome := 'invalid_event';
    elsif v_tx.status = 'paid' then
      v_outcome := 'already_paid';
    elsif v_tx.status = 'refunded' then
      v_outcome := 'already_refunded';
    else
      update public.poketo_transactions
      set
        status = 'paid',
        provider_status = 'paid',
        paid_at = coalesce(paid_at, now()),
        failure_reason = null
      where id = v_tx.id;

      update public.poketo_payment_orders
      set status = 'paid', paid_at = coalesce(paid_at, now())
      where id = v_order.id;

      v_outcome := 'paid';
    end if;
  elsif p_event_type = 'invoice.expired' then
    if p_invoice_status = 'expired' and v_tx.status = 'pending' then
      update public.poketo_transactions
      set status = 'expired', provider_status = 'expired'
      where id = v_tx.id;
      v_outcome := 'expired';
    else
      v_outcome := 'ignored';
    end if;
  elsif p_event_type = 'invoice.cancelled' then
    if p_invoice_status = 'cancelled' and v_tx.status = 'pending' then
      update public.poketo_transactions
      set status = 'cancelled', provider_status = 'cancelled'
      where id = v_tx.id;
      v_outcome := 'cancelled';
    else
      v_outcome := 'ignored';
    end if;
  elsif p_event_type = 'invoice.refunded' then
    if p_invoice_status = 'refunded' and v_tx.status = 'paid' then
      update public.poketo_transactions
      set status = 'refunded', provider_status = 'refunded'
      where id = v_tx.id;
      v_outcome := 'refunded';
    else
      v_outcome := 'ignored';
    end if;
  end if;

  update public.poketo_webhook_events
  set outcome = v_outcome, processed_at = now()
  where event_id = p_event_id;

  return jsonb_build_object('outcome', v_outcome);
end;
$$;

revoke all on function public.apply_poketo_webhook_event(
  text, text, text, text, text, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.apply_poketo_webhook_event(
  text, text, text, text, text, bigint, text, text
) to service_role;

drop trigger if exists poketo_payment_orders_set_updated_at on public.poketo_payment_orders;
create trigger poketo_payment_orders_set_updated_at
before update on public.poketo_payment_orders
for each row execute function public.set_updated_at();

drop trigger if exists poketo_transactions_set_updated_at on public.poketo_transactions;
create trigger poketo_transactions_set_updated_at
before update on public.poketo_transactions
for each row execute function public.set_updated_at();
