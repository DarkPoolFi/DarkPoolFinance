-- Threshold sealing committee (plan.md X3): members' partial decryptions of sealed orders, verified by the operator
-- before they are stored. A partial reveals nothing on its own; `threshold` of them open one order. Re-runnable.

create table if not exists dark_pool_partials (
  sealed_hash text not null, -- keccak256 of the ciphertext
  member int not null,
  partial jsonb not null,
  created_at timestamptz not null default now(),
  primary key (sealed_hash, member)
);
alter table dark_pool_partials enable row level security;

-- p_rows: [{sealed_hash, member, partial}]; returns how many were new.
create or replace function dark_pool_put_partials(p_rows jsonb) returns int
language plpgsql set search_path = public as $$
declare
  v_inserted int;
begin
  insert into dark_pool_partials (sealed_hash, member, partial)
  select lower(r->>'sealed_hash'), (r->>'member')::int, r->'partial' from jsonb_array_elements(p_rows) r
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end $$;

-- {sealed_hash: [partial, …]} for the given ciphertext hashes.
create or replace function dark_pool_partials_for(p_hashes text[]) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(sealed_hash, partials), '{}')
    from (select sealed_hash, jsonb_agg(partial order by member) partials
            from dark_pool_partials
           where sealed_hash = any(select lower(h) from unnest(p_hashes) h)
           group by sealed_hash) p
$$;

revoke execute on function dark_pool_put_partials(jsonb), dark_pool_partials_for(text[]) from public, anon, authenticated;
grant execute on function dark_pool_put_partials(jsonb), dark_pool_partials_for(text[]) to service_role;
