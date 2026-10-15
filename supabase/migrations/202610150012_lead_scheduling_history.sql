-- HIGH CLOSER: keep booking evidence inside the existing lead JSON document.
-- No backfill: a historical callDate proves booking, not its original instant.
begin;

create function private.valid_scheduling_timestamp(p_value jsonb) returns boolean
language plpgsql stable set search_path = ''
as $$ begin
  if jsonb_typeof(p_value) is distinct from 'string'
    or p_value #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then return false; end if;
  return isfinite((p_value #>> '{}')::timestamptz);
exception when others then return false;
end; $$;

create function private.preserve_lead_scheduling_history() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare first_booking text; previously_booked boolean:=false; booked boolean:=false; historical_import boolean:=false;
begin
  if new.data ? 'firstScheduledAt' and not private.valid_scheduling_timestamp(new.data->'firstScheduledAt') then
    raise exception 'Data do primeiro agendamento inválida.' using errcode='23514'; end if;
  if new.data ? 'hasBeenScheduled' and jsonb_typeof(new.data->'hasBeenScheduled') is distinct from 'boolean' then
    raise exception 'Histórico de agendamento inválido.' using errcode='23514'; end if;
  if tg_op='UPDATE' then
    if private.valid_scheduling_timestamp(old.data->'firstScheduledAt') then first_booking:=old.data->>'firstScheduledAt'; end if;
    previously_booked:=first_booking is not null or old.data->'hasBeenScheduled'='true'::jsonb
      or private.valid_scheduling_timestamp(old.data->'callDate');
    booked:=coalesce(previously_booked,false) or private.valid_scheduling_timestamp(new.data->'callDate');
    -- First booking is server-authored. A stale document cannot replace or
    -- remove an already known instant, even after the current call is cleared.
    if not coalesce(previously_booked,false) and private.valid_scheduling_timestamp(new.data->'callDate') then
      first_booking:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); end if;
  else
    -- The flag affects historical interpretation only, never authorization.
    -- CSV/XLSX snapshots already carry server-created importMetadata.
    historical_import:=coalesce(current_setting('closer_os.historical_lead_import',true),'')='true'
      or jsonb_typeof(new.data->'importMetadata')='object';
    if coalesce(historical_import,false) then
      if private.valid_scheduling_timestamp(new.data->'firstScheduledAt') then first_booking:=new.data->>'firstScheduledAt'; end if;
      booked:=first_booking is not null or new.data->'hasBeenScheduled'='true'::jsonb
        or private.valid_scheduling_timestamp(new.data->'callDate');
    elsif private.valid_scheduling_timestamp(new.data->'callDate') then
      booked:=true;
      first_booking:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    end if;
  end if;
  new.data:=new.data-'firstScheduledAt'-'hasBeenScheduled';
  if coalesce(booked,false) then
    new.data:=new.data||jsonb_build_object('hasBeenScheduled',true);
    if first_booking is not null then new.data:=new.data||jsonb_build_object('firstScheduledAt',first_booking); end if;
  end if;
  return new;
end; $$;

-- Alphabetical BEFORE trigger order keeps the existing stage preparation first.
create trigger lead_scheduling_history before insert or update on public.leads
for each row execute function private.preserve_lead_scheduling_history();

-- Existing JSON restore remains insert-only and uses exactly the same guards.
-- The scoped flag prevents inventing historical timestamps for old backups.
create or replace function public.import_leads(p_workspace_id uuid, p_leads jsonb, p_owner_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare assigned_owner uuid := coalesce(p_owner_id,auth.uid()); item jsonb; imported integer := 0; input_count integer; affected integer;
  previous_import_context text:=coalesce(current_setting('closer_os.historical_lead_import',true),'');
begin
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if auth.uid() is null or not coalesce(private.can_write_lead(p_workspace_id,assigned_owner),false) then raise exception 'Importação não autorizada.' using errcode = '42501'; end if;
  perform private.assert_available(p_workspace_id);
  if not private.assignable_owner(p_workspace_id,assigned_owner) then raise exception 'Responsável precisa ser um membro ativo com permissão de edição.' using errcode = '23514'; end if;
  if jsonb_typeof(p_leads) is distinct from 'array' then raise exception 'Envie uma lista de leads.' using errcode = '22023'; end if;
  input_count := jsonb_array_length(p_leads);
  if input_count > 1000 then raise exception 'Importe até 1000 leads por lote.' using errcode = '22023'; end if;
  -- Validate the whole batch before writing. Existing IDs are never overwritten.
  for item in select value from jsonb_array_elements(p_leads) loop
    if not private.valid_lead_data(item) then raise exception 'Lead inválido no backup. Nenhum registro foi importado.' using errcode = '22023'; end if;
  end loop;
  perform set_config('closer_os.historical_lead_import','true',true);
  for item in select value from jsonb_array_elements(p_leads) loop
    insert into public.leads(workspace_id,id,owner_id,data,stage_id,loss_reason_grandfathered) values(p_workspace_id,item ->> 'id',assigned_owner,item,private.resolve_import_stage(p_workspace_id,item),(item->>'status'='Perdido' and nullif(item->>'lossReason','') is null)) on conflict(workspace_id,id) do nothing;
    get diagnostics affected = row_count;
    imported := imported + affected;
  end loop;
  perform set_config('closer_os.historical_lead_import',previous_import_context,true);
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'leads.imported',jsonb_build_object('imported',imported,'skipped',input_count - imported));
  return jsonb_build_object('imported',imported,'skipped',input_count - imported);
exception when others then
  perform set_config('closer_os.historical_lead_import',previous_import_context,true);
  raise;
end; $$;

revoke all on function private.valid_scheduling_timestamp(jsonb),private.preserve_lead_scheduling_history() from public,anon,authenticated;
-- CREATE OR REPLACE retains the JSON importer's existing authenticated/service ACL.
comment on function private.preserve_lead_scheduling_history() is 'Monotonic booking evidence in lead JSON. Genuine new bookings use server time; historical imports never manufacture unknown first-booking timestamps. No authorization bypass.';

notify pgrst,'reload schema';
commit;
