-- Trusted order ledger and atomic Duitku callback reconciliation.
-- Orders must be created by a trusted server using a backend-only key.
-- Browser clients receive read-only access to their own order rows.

create table if not exists public.duitku_payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  amount bigint not null check (amount > 0),
  currency text not null default 'IDR' check (currency = 'IDR'),
  product_details text not null check (char_length(product_details) between 1 and 255),
  customer_email text not null,
  customer_phone text,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'cancelled', 'expired')),
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists duitku_payment_orders_user_created_idx
  on public.duitku_payment_orders (user_id, created_at desc);
create index if not exists duitku_payment_orders_status_created_idx
  on public.duitku_payment_orders (status, created_at desc);

alter table public.duitku_payment_orders enable row level security;

drop policy if exists "Users can read their own payment orders"
  on public.duitku_payment_orders;
create policy "Users can read their own payment orders"
  on public.duitku_payment_orders
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.duitku_payment_orders from anon, authenticated;
grant select on table public.duitku_payment_orders to authenticated;
grant all on table public.duitku_payment_orders to service_role;
grant all on table public.duitku_transactions to service_role;

alter table public.duitku_transactions
  add column if not exists order_id uuid
  references public.duitku_payment_orders(id) on delete restrict;

-- Permit historical failed/expired attempts while preventing more than one
-- pending invoice attempt for the same order. Verified payments remain historical records.
create unique index if not exists duitku_transactions_one_active_order_idx
  on public.duitku_transactions (order_id)
  where order_id is not null and status = 'pending';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists duitku_payment_orders_set_updated_at on public.duitku_payment_orders;
create trigger duitku_payment_orders_set_updated_at
before update on public.duitku_payment_orders
for each row execute function public.set_updated_at();

drop trigger if exists duitku_transactions_set_updated_at on public.duitku_transactions;
create trigger duitku_transactions_set_updated_at
before update on public.duitku_transactions
for each row execute function public.set_updated_at();

-- A single database transaction reconciles callback state and the associated
-- order. Only the service_role may invoke this function through PostgREST.
create or replace function public.apply_duitku_callback(
  p_merchant_order_id text,
  p_amount bigint,
  p_merchant_code text,
  p_result_code text,
  p_reference text,
  p_callback_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx record;
  v_order_status text;
  v_late_payment boolean := false;
begin
  -- Find the order relation first, then lock order before transaction. This
  -- consistent lock order serializes callbacks for different attempts of one order.
  select t.id, t.order_id
  into v_tx
  from public.duitku_transactions as t
  where t.merchant_order_id = p_merchant_order_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_tx.order_id is not null then
    select o.status
    into v_order_status
    from public.duitku_payment_orders as o
    where o.id = v_tx.order_id
    for update;

    if not found then
      raise exception 'Payment order % not found for transaction %', v_tx.order_id, v_tx.id;
    end if;
  end if;

  select
    t.id,
    t.order_id,
    t.amount,
    t.merchant_code,
    t.status,
    t.duitku_reference
  into v_tx
  from public.duitku_transactions as t
  where t.id = v_tx.id
  for update;

  if v_tx.amount <> p_amount or v_tx.merchant_code <> p_merchant_code then
    return jsonb_build_object('outcome', 'transaction_mismatch');
  end if;

  if p_reference is null or p_reference = '' then
    return jsonb_build_object('outcome', 'reference_required');
  end if;

  if v_tx.duitku_reference is not null and v_tx.duitku_reference <> p_reference then
    return jsonb_build_object('outcome', 'reference_mismatch');
  end if;

  if p_result_code is null or p_result_code not in ('00', '01', '02') then
    return jsonb_build_object('outcome', 'unsupported_result_code');
  end if;

  if v_tx.status = 'paid' then
    return jsonb_build_object('outcome', 'already_paid');
  end if;

  if p_result_code = '00' then
    if v_tx.order_id is not null then
      -- A delayed success from an earlier attempt may arrive after a retry has
      -- created a newer pending invoice. Close those pending attempts first.
      update public.duitku_transactions
      set
        status = 'expired',
        failure_reason = 'Superseded by another verified payment for this order'
      where order_id = v_tx.order_id
        and id <> v_tx.id
        and status = 'pending';

      v_late_payment := v_order_status in ('cancelled', 'expired', 'paid');

      update public.duitku_payment_orders
      set status = 'paid', paid_at = coalesce(paid_at, now())
      where id = v_tx.order_id;
    end if;

    update public.duitku_transactions
    set
      status = 'paid',
      duitku_reference = coalesce(duitku_reference, p_reference),
      callback_result_code = p_result_code,
      callback_reference = p_reference,
      callback_payload = p_callback_payload,
      paid_at = coalesce(paid_at, now()),
      failure_reason = null
    where id = v_tx.id;

    return jsonb_build_object(
      'outcome', 'paid',
      'late_payment', v_late_payment
    );
  end if;

  if v_tx.status = 'pending' then
    update public.duitku_transactions
    set
      status = 'failed',
      callback_result_code = p_result_code,
      callback_reference = p_reference,
      callback_payload = p_callback_payload,
      failure_reason = 'Duitku resultCode ' || p_result_code
    where id = v_tx.id;
  end if;

  return jsonb_build_object('outcome', 'failed');
end;
$$;

revoke all on function public.apply_duitku_callback(text, bigint, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_duitku_callback(text, bigint, text, text, text, jsonb)
  to service_role;

-- Called by an external scheduler through the protected expiry Edge Function.
-- Order rows are locked before their pending transactions, matching callback lock order.
create or replace function public.expire_pending_duitku_payment_orders(
  p_as_of timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired_count integer;
begin
  with expired_orders as (
    update public.duitku_payment_orders as o
    set status = 'expired'
    where o.status = 'pending'
      and o.expires_at is not null
      and o.expires_at <= p_as_of
    returning o.id
  ),
  expired_transactions as (
    update public.duitku_transactions as t
    set
      status = 'expired',
      failure_reason = coalesce(t.failure_reason, 'Payment order expired')
    where t.order_id in (select e.id from expired_orders as e)
      and t.status = 'pending'
    returning t.id
  )
  select count(*)::integer into v_expired_count from expired_orders;

  return coalesce(v_expired_count, 0);
end;
$$;

revoke all on function public.expire_pending_duitku_payment_orders(timestamptz)
  from public, anon, authenticated;
grant execute on function public.expire_pending_duitku_payment_orders(timestamptz)
  to service_role;

revoke all on function public.set_updated_at() from public, anon, authenticated;
