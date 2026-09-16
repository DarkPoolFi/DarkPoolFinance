-- X2 backstop (plan.md X2): shielded-pool solvency counts the vault leg of settlements. BackstopSettled carries base
-- units (wei, token base units): buyers' ETH leaves the pool to the vault and the tokens it sold arrive; sellers' tokens
-- leave and the vault's ETH arrives. Re-runnable.

create or replace function dark_pool_flows() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(asset, net::text), '{}')
    from (select asset, sum(amount) net
            from (select lower(args->>'asset') asset, (args->>'amount')::numeric amount
                    from dark_pool_events where name = 'Deposited'
                  union all
                  select lower(args->>'asset'), -((args->>'released')::numeric + (args->>'fee')::numeric)
                    from dark_pool_events where name = 'Transacted'
                  union all
                  select '0x0000000000000000000000000000000000000000', -(args->>'fee')::numeric
                    from dark_pool_events where name = 'OrderFeePaid'
                  union all
                  select '0x0000000000000000000000000000000000000000', (args->>'ethOut')::numeric - (args->>'ethIn')::numeric
                    from dark_pool_events where name = 'BackstopSettled'
                  union all
                  select lower(args->>'asset'), (args->>'sold')::numeric - (args->>'bought')::numeric
                    from dark_pool_events where name = 'BackstopSettled') f
           group by asset) s
$$;

revoke execute on function dark_pool_flows() from public, anon, authenticated;
grant execute on function dark_pool_flows() to service_role;
