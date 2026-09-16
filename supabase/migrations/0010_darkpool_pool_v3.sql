-- Shielded pool v3 operator state (plan.md X1.1 association sets, operator funding, tree cache). Everything here is
-- derived from public chain data or the operator's own bookkeeping. Re-runnable.

-- Association roots the operator posted to the screening gate, with the label list each was built from (in leaf
-- order), so clients can prove membership against a root that is on chain.
create table if not exists dark_pool_associations (
  root text primary key,
  labels jsonb not null,
  created_at timestamptz not null default now()
);
alter table dark_pool_associations enable row level security;

-- Settlement fee notes (owner DARKPOOL_FEE_OWNER), recorded before the settlement is sent, for the sweep.
create table if not exists dark_pool_fee_notes (
  commitment text primary key,
  asset text not null,
  epoch bigint not null,
  amount numeric not null,
  spent boolean not null default false,
  created_at timestamptz not null default now()
);
alter table dark_pool_fee_notes enable row level security;

-- Small operator caches (the commitment tree's frontier).
create table if not exists dark_pool_state (
  name text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table dark_pool_state enable row level security;

-- Every deposit's depositor and label, in chain order.
create or replace function dark_pool_deposit_labels() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('from', lower(args->>'from'), 'label', args->>'label') order by block, log_index), '[]')
    from dark_pool_events where name = 'Deposited'
$$;

create or replace function dark_pool_put_association(p_root text, p_labels jsonb) returns void
language sql set search_path = public as $$
  insert into dark_pool_associations (root, labels) values (lower(p_root), p_labels) on conflict (root) do nothing
$$;

-- Newest first.
create or replace function dark_pool_recent_associations(p_limit int default 8) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('root', root, 'labels', labels) order by created_at desc), '[]')
    from (select * from dark_pool_associations order by created_at desc limit p_limit) a
$$;

create or replace function dark_pool_put_fee_note(p_commitment text, p_asset text, p_epoch bigint, p_amount numeric) returns void
language sql set search_path = public as $$
  insert into dark_pool_fee_notes (commitment, asset, epoch, amount) values (lower(p_commitment), lower(p_asset), p_epoch, p_amount)
  on conflict (commitment) do nothing
$$;

-- Unswept fee notes with their leaf index once committed (null before).
create or replace function dark_pool_fee_notes_indexed() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('commitment', f.commitment, 'asset', f.asset, 'epoch', f.epoch, 'amount', f.amount::text,
                                               'index', (c.args->>'index')::bigint) order by f.epoch), '[]')
    from dark_pool_fee_notes f
    left join dark_pool_events c on c.name = 'Committed' and lower(c.args->>'commitment') = f.commitment
   where f.amount > 0 and not f.spent
$$;

create or replace function dark_pool_fee_notes_spent(p_commitments text[]) returns void
language sql set search_path = public as $$
  update dark_pool_fee_notes set spent = true where commitment = any(select lower(x) from unnest(p_commitments) x)
$$;

create or replace function dark_pool_get_state(p_name text) returns jsonb
language sql stable set search_path = public as $$
  select value from dark_pool_state where name = p_name
$$;

create or replace function dark_pool_put_state(p_name text, p_value jsonb) returns void
language sql set search_path = public as $$
  insert into dark_pool_state (name, value) values (p_name, p_value)
  on conflict (name) do update set value = excluded.value, updated_at = now()
$$;

revoke execute on function
  dark_pool_deposit_labels(), dark_pool_put_association(text, jsonb), dark_pool_recent_associations(int),
  dark_pool_put_fee_note(text, text, bigint, numeric), dark_pool_fee_notes_indexed(), dark_pool_fee_notes_spent(text[]), dark_pool_get_state(text), dark_pool_put_state(text, jsonb)
from public, anon, authenticated;
grant execute on function
  dark_pool_deposit_labels(), dark_pool_put_association(text, jsonb), dark_pool_recent_associations(int),
  dark_pool_put_fee_note(text, text, bigint, numeric), dark_pool_fee_notes_indexed(), dark_pool_fee_notes_spent(text[]), dark_pool_get_state(text), dark_pool_put_state(text, jsonb)
to service_role;
