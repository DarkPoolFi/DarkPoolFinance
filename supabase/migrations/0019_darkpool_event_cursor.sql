-- DarkpoolFi event pagination cursor (TECH_UPDATES TU-19). Re-runnable. Needs 0008.
--
-- Pages resumed on `block > p_after_block`, so a 5,000-row page whose cut fell inside a block left the rest of that
-- block behind: a caller that advanced past it never saw those logs again, and a client's balance silently lost
-- whatever they carried. The cursor is now the (block, log_index) of the last row returned.
--
-- p_after_log defaults past every log index, so a caller that passes only a block still gets "strictly after this
-- whole block" and old clients keep working against the new function.

drop function if exists dark_pool_events(text[], bigint, int);

create or replace function dark_pool_events(p_names text[], p_after_block bigint default -1, p_after_log int default 2147483647, p_limit int default 5000) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('block', block, 'log_index', log_index, 'tx_hash', tx_hash, 'name', name, 'args', args)
                            order by block, log_index), '[]')
    from (select * from dark_pool_events
           where name = any(p_names) and (block, log_index) > (p_after_block, p_after_log)
           order by block, log_index limit p_limit) e
$$;

revoke execute on function dark_pool_events(text[], bigint, int, int) from public, anon, authenticated;
grant execute on function dark_pool_events(text[], bigint, int, int) to service_role;
