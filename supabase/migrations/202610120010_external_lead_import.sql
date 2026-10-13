-- Tenant-only external CSV/XLSX imports. Legacy JSON import_leads is untouched.
-- Original files and raw source identifiers never persist here.
begin;

create table private.external_import_keys (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key_type text not null check(key_type in ('row','source')),
  key_hash text not null check(key_hash ~ '^[a-f0-9]{64}$'),
  lead_id text not null check(length(lead_id) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,key_type,key_hash)
);
alter table private.external_import_keys enable row level security;
revoke all on private.external_import_keys from public,anon,authenticated;
grant all on private.external_import_keys to service_role;

-- A lead FK would acquire KEY SHARE on an existing duplicate while the
-- importer owns its workspace. Direct lead editors can already own that lead
-- before the existing prepare trigger requests the workspace, creating the
-- opposite lock order. Keep this private ledger nonlocking and clean it in the
-- same transaction as deletion. Lookups below also require a live tenant lead.
create index external_import_keys_lead_idx on private.external_import_keys(workspace_id,lead_id);
create function private.cleanup_external_import_keys() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  -- A duplicate importer can add aliases while a direct deleter owns the lead
  -- row. Wait for that importer without requesting the lead lock, then use a
  -- fresh statement snapshot to remove every committed alias atomically.
  perform 1 from public.workspaces where id=old.workspace_id for update;
  delete from private.external_import_keys where workspace_id=old.workspace_id and lead_id=old.id;
  return null;
end; $$;
create trigger external_import_keys_cleanup after delete on public.leads
  for each row execute function private.cleanup_external_import_keys();

create function private.assert_external_import(p_workspace_id uuid,p_records jsonb,p_source_namespace text,p_lock boolean) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  -- Do not use can_manage_workspace: Master is not a commercial membership.
  if p_lock then perform 1 from public.workspaces where id=p_workspace_id for update; end if;
  if auth.uid() is null or not coalesce(private.workspace_role(p_workspace_id) in ('admin','manager'),false) then
    raise exception 'Somente administradores e gestores da própria empresa podem importar planilhas.' using errcode='42501'; end if;
  perform private.assert_available(p_workspace_id);
  if jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) not between 1 and 500
    or octet_length(p_records::text)>1048576 then
    raise exception 'Envie de 1 a 500 registros e até 1 MB por lote.' using errcode='22023'; end if;
  if p_source_namespace is not null and (length(btrim(p_source_namespace)) not between 1 and 120 or p_source_namespace ~ '[[:cntrl:]]') then
    raise exception 'Informe uma identificação válida para o CRM de origem.' using errcode='22023'; end if;
  if (select count(*) from jsonb_array_elements(p_records) e)<>(select count(distinct e->>'rowNumber') from jsonb_array_elements(p_records) e) then
    raise exception 'Cada registro precisa ter um número de linha único no lote.' using errcode='22023'; end if;
end; $$;

create function private.prepare_external_import_record(p_workspace_id uuid,p_record jsonb,p_source_namespace text) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone='UTC'
as $$ declare
  item jsonb; field text; text_value text; stage public.pipeline_stages; owner uuid; stamp text;
  email text; phone text; row_number integer; source_hash text; row_key text;
begin
  if jsonb_typeof(p_record) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_record) k
      where k not in ('rowNumber','rowKey','stageId','ownerId','lead','sourceId'))
    or jsonb_typeof(p_record->'rowNumber') is distinct from 'number' or (p_record->>'rowNumber') !~ '^[0-9]+$'
    or jsonb_typeof(p_record->'rowKey') is distinct from 'string' or p_record->>'rowKey' !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('code','INVALID_RECORD'); end if;
  row_number:=(p_record->>'rowNumber')::integer;
  if row_number not between 1 and 100000 then return jsonb_build_object('code','INVALID_RECORD'); end if;
  row_key:=p_record->>'rowKey'; item:=p_record->'lead';
  if jsonb_typeof(item) is distinct from 'object' then return jsonb_build_object('code','INVALID_RECORD'); end if;
  -- Whitelist the current lead snapshot. Imports cannot inject reviews,
  -- recordings, tasks, permissions or invented sales/call history.
  if exists(select 1 from jsonb_object_keys(item) k where k not in (
    'id','name','company','email','phone','ticket','source','createdAt','callDate','attendance','objection','status','closedValue','closedAt',
    'lastContactAt','notes','pain','urgency','financialCapacity','decisionMaker','callScore','closerError','callSummary',
    'stageId','stageType','stageName','lossReason','lossComment','recordingUrl','nextStep'))
    or (item ? 'callScore' and item->'callScore'<>'null'::jsonb)
    or coalesce(item->>'closerError','')<>'' or coalesce(item->>'callSummary','')<>'' or coalesce(item->>'recordingUrl','')<>'' then
    return jsonb_build_object('code','PROTECTED_FIELD'); end if;
  if jsonb_typeof(p_record->'stageId') is distinct from 'string' then return jsonb_build_object('code','STAGE_INVALID'); end if;
  select s.* into stage from public.pipeline_stages s join public.pipelines p on p.workspace_id=s.workspace_id and p.id=s.pipeline_id
    where s.workspace_id=p_workspace_id and s.id=(p_record->>'stageId')::uuid and s.active and p.is_default;
  if not found then return jsonb_build_object('code','STAGE_INVALID'); end if;
  if jsonb_typeof(p_record->'ownerId') is distinct from 'string' then return jsonb_build_object('code','OWNER_INVALID'); end if;
  owner:=(p_record->>'ownerId')::uuid;
  if not coalesce(private.assignable_owner(p_workspace_id,owner),false) then return jsonb_build_object('code','OWNER_INVALID'); end if;
  foreach field in array array['name','company','email','phone','source','notes','objection','pain','lossComment','nextStep'] loop
    if item ? field and jsonb_typeof(item->field) is distinct from 'string' then return jsonb_build_object('code','FIELD_INVALID'); end if;
    text_value:=coalesce(item->>field,'');
    if length(text_value)>(case field when 'name' then 200 when 'company' then 200 when 'email' then 254 when 'phone' then 64 when 'source' then 120 when 'lossComment' then 4000 else 10000 end)
      or (field in ('name','company','email','phone','source') and text_value ~ '[[:cntrl:]]') then return jsonb_build_object('code','FIELD_INVALID'); end if;
    item:=item||jsonb_build_object(field,case when field in ('name','company','email','phone','source') then btrim(text_value) else text_value end);
  end loop;
  if coalesce(item->>'name','')='' then return jsonb_build_object('code','NAME_REQUIRED'); end if;
  email:=lower(btrim(item->>'email')); phone:=regexp_replace(item->>'phone','[^0-9]','','g');
  if email<>'' and email !~ '^[^[:space:]@<>"\\]+@[^[:space:]@<>"\\]+\.[^[:space:]@<>"\\]+$' then return jsonb_build_object('code','EMAIL_INVALID'); end if;
  if item->>'phone'<>'' and (item->>'phone' !~ '^[0-9+(). /-]+$' or length(phone) not between 5 and 32) then return jsonb_build_object('code','PHONE_INVALID'); end if;
  if p_record ? 'sourceId' and p_record->'sourceId'<>'null'::jsonb and p_record->>'sourceId'<>'' then
    if p_source_namespace is null or jsonb_typeof(p_record->'sourceId') is distinct from 'string'
      or length(btrim(p_record->>'sourceId')) not between 1 and 200 or p_record->>'sourceId' ~ '[[:cntrl:]]' then
      return jsonb_build_object('code','SOURCE_ID_INVALID'); end if;
    source_hash:=encode(extensions.digest(jsonb_build_array(lower(btrim(p_source_namespace)),btrim(p_record->>'sourceId'))::text,'sha256'),'hex');
  end if;
  foreach field in array array['createdAt','lastContactAt','callDate','closedAt'] loop
    if item ? field and jsonb_typeof(item->field) is distinct from 'string' then
      return jsonb_build_object('code','DATE_INVALID'); end if;
    if coalesce(item->>field,'')<>'' and item->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      return jsonb_build_object('code','DATE_INVALID'); end if;
  end loop;
  if stage.type<>'WON' and ((jsonb_typeof(item->'closedValue')='number' and (item->>'closedValue')::numeric<>0)
      or coalesce(item->>'closedAt','')<>'') then return jsonb_build_object('code','CLOSED_DATA_STAGE_INVALID'); end if;
  stamp:=to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  item:=item||jsonb_build_object('id','import-'||row_key,'email',email,'phone',case when left(item->>'phone',1)='+' and phone<>'' then '+'||phone else phone end,
    'createdAt',coalesce(nullif(item->>'createdAt',''),stamp),'lastContactAt',coalesce(nullif(item->>'lastContactAt',''),stamp),
    'callDate',coalesce(item->>'callDate',''),'closedAt',coalesce(item->>'closedAt',''),
    'callScore',null,'closerError','','callSummary','','recordingUrl','',
    'importMetadata',jsonb_build_object('createdAtSource',case when coalesce(item->>'createdAt','')='' then 'import' else 'provided' end,
      'lastContactAtSource',case when coalesce(item->>'lastContactAt','')='' then 'import' else 'provided' end,'importedAt',stamp),
    'stageId',stage.id,'stageName',stage.name,'stageType',stage.type,'status',case stage.type when 'WON' then 'Fechado' when 'LOST' then 'Perdido' else stage.legacy_status end);
  -- prepare_lead normally supplies a won date/attendance for manual edits.
  -- Migrated records must provide the real required facts before that trigger.
  if stage.type='WON' and (jsonb_typeof(item->'closedValue') is distinct from 'number' or (item->>'closedValue')::numeric<=0
      or item->>'closedAt'='' or item->>'attendance' is distinct from 'Compareceu') then return jsonb_build_object('code','WON_DATA_REQUIRED'); end if;
  if stage.type='LOST' and coalesce(nullif(btrim(item->>'lossReason'),''),'')='' then return jsonb_build_object('code','LOSS_REASON_REQUIRED'); end if;
  if not private.valid_lead_data(item) then return jsonb_build_object('code','FIELD_INVALID'); end if;
  foreach field in array array['createdAt','lastContactAt','callDate','closedAt'] loop
    if item->>field<>'' and not isfinite((item->>field)::timestamptz) then return jsonb_build_object('code','DATE_INVALID'); end if;
  end loop;
  return jsonb_build_object('rowNumber',row_number,'rowKey',row_key,'sourceHash',source_hash,'stageId',stage.id,'ownerId',owner,
    'email',email,'phone',phone,'lead',item);
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
  return jsonb_build_object('code','FIELD_INVALID');
end; $$;

create function private.external_import_matches(p_workspace_id uuid,p_record jsonb,p_seen jsonb) returns text[]
language sql stable security definer set search_path = ''
as $$ select coalesce(array_agg(distinct id),'{}'::text[]) from (
  select l.id from public.leads l where l.workspace_id=p_workspace_id and (
    l.id=p_record->'lead'->>'id'
    or (p_record->>'email'<>'' and nullif(btrim(l.data->>'email'),'') is not null
      and extensions.digest(lower(btrim(l.data->>'email')),'sha256')=extensions.digest(p_record->>'email','sha256')
      and lower(btrim(l.data->>'email'))=p_record->>'email')
    or (p_record->>'phone'<>'' and regexp_replace(l.data->>'phone','[^0-9]','','g')<>''
      and extensions.digest(regexp_replace(l.data->>'phone','[^0-9]','','g'),'sha256')=extensions.digest(p_record->>'phone','sha256')
      and regexp_replace(l.data->>'phone','[^0-9]','','g')=p_record->>'phone'))
  union all
  select k.lead_id from private.external_import_keys k
    join public.leads l on l.workspace_id=k.workspace_id and l.id=k.lead_id where k.workspace_id=p_workspace_id and (
    (k.key_type='row' and k.key_hash=p_record->>'rowKey') or (k.key_type='source' and k.key_hash=p_record->>'sourceHash'))
  union all
  select e->>'id' from jsonb_array_elements(p_seen) e where e->>'rowKey'=p_record->>'rowKey'
    or (p_record->>'email'<>'' and e->>'email'=p_record->>'email')
    or (p_record->>'phone'<>'' and e->>'phone'=p_record->>'phone')
    or (p_record->>'sourceHash' is not null and e->>'sourceHash'=p_record->>'sourceHash')
) matches; $$;

create function private.external_import_identity(p_workspace_id uuid,p_lead_id text) returns text
language sql immutable set search_path = ''
as $$ select encode(extensions.digest(jsonb_build_array(p_workspace_id,p_lead_id)::text,'sha256'),'hex'); $$;

create function private.external_import_preview_context(p_workspace_id uuid,p_context jsonb,p_batch_size integer) returns jsonb
language plpgsql immutable set search_path = ''
as $$ declare entry jsonb; field text; entries jsonb;
begin
  if p_context is null then return '[]'::jsonb; end if;
  if octet_length(p_context::text)>4194304 or jsonb_typeof(p_context) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_context) k where k not in ('workspaceId','entries'))
      or jsonb_typeof(p_context->'workspaceId') is distinct from 'string'
      or p_context->>'workspaceId' is distinct from p_workspace_id::text
      or jsonb_typeof(p_context->'entries') is distinct from 'array' then
    raise exception 'A prévia pertence a outra empresa ou é inválida. Revise novamente o arquivo.' using errcode='22023'; end if;
  entries:=p_context->'entries';
  if jsonb_array_length(entries)+p_batch_size>10000 then
    raise exception 'A prévia está limitada a 10.000 registros.' using errcode='22023'; end if;
  for entry in select value from jsonb_array_elements(entries) loop
    if jsonb_typeof(entry) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(entry) k where k not in ('id','rowKey','sourceHash','emailHash','phoneHash'))
        or jsonb_typeof(entry->'id') is distinct from 'string' or entry->>'id' !~ '^[a-f0-9]{64}$'
        or jsonb_typeof(entry->'rowKey') is distinct from 'string' or entry->>'rowKey' !~ '^[a-f0-9]{64}$' then
      raise exception 'A continuação da prévia é inválida. Revise novamente o arquivo.' using errcode='22023'; end if;
    foreach field in array array['sourceHash','emailHash','phoneHash'] loop
      if not(entry ? field) or (entry->field<>'null'::jsonb and (jsonb_typeof(entry->field) is distinct from 'string'
          or entry->>field !~ '^[a-f0-9]{64}$')) then
        raise exception 'A continuação da prévia é inválida. Revise novamente o arquivo.' using errcode='22023'; end if;
    end loop;
  end loop;
  return entries;
end; $$;

create function public.preview_import_leads(p_workspace_id uuid,p_records jsonb,p_source_namespace text default null,p_context jsonb default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare
  raw jsonb; item jsonb; seen jsonb; results jsonb:='[]'; ids text[]; lead_identity text; status text;
  email_hash text; phone_hash text; context jsonb;
  new_count integer:=0; duplicate_count integer:=0; conflict_count integer:=0; error_count integer:=0;
begin
  perform private.assert_external_import(p_workspace_id,p_records,p_source_namespace,false);
  -- Continuation contains only hashes supplied by this authorized importer.
  -- It estimates virtual rows across batches; the write RPC never accepts it.
  seen:=private.external_import_preview_context(p_workspace_id,p_context,jsonb_array_length(p_records));
  for raw in select value from jsonb_array_elements(p_records) loop
    item:=private.prepare_external_import_record(p_workspace_id,raw,p_source_namespace);
    if item ? 'code' then
      error_count:=error_count+1;
      results:=results||jsonb_build_array(jsonb_build_object('rowNumber',raw->'rowNumber','status','error','code',item->>'code'));
      continue;
    end if;
    email_hash:=case when item->>'email'<>'' then encode(extensions.digest(item->>'email','sha256'),'hex') end;
    phone_hash:=case when item->>'phone'<>'' then encode(extensions.digest(item->>'phone','sha256'),'hex') end;
    select coalesce(array_agg(distinct identity),'{}'::text[]) into ids from (
      select private.external_import_identity(p_workspace_id,id) as identity
        from unnest(private.external_import_matches(p_workspace_id,item,'[]')) id
      union all
      select e->>'id' from jsonb_array_elements(seen) e where e->>'rowKey'=item->>'rowKey'
        or (email_hash is not null and e->>'emailHash'=email_hash)
        or (phone_hash is not null and e->>'phoneHash'=phone_hash)
        or (item->>'sourceHash' is not null and e->>'sourceHash'=item->>'sourceHash')
    ) matches;
    if cardinality(ids)>1 then status:='conflict'; conflict_count:=conflict_count+1;
    elsif cardinality(ids)=1 then status:='duplicate'; duplicate_count:=duplicate_count+1; lead_identity:=ids[1];
    else status:='new'; new_count:=new_count+1; lead_identity:=private.external_import_identity(p_workspace_id,item->'lead'->>'id'); end if;
    results:=results||jsonb_build_array(jsonb_build_object('rowNumber',item->'rowNumber','status',status));
    -- Skipping a duplicate registers retry aliases but never merges its new
    -- contacts into the existing lead. Model exactly the same behavior here.
    if status<>'conflict' then seen:=seen||jsonb_build_array(jsonb_build_object('id',lead_identity,'rowKey',item->'rowKey',
      'sourceHash',item->'sourceHash','emailHash',case when status='new' then email_hash end,
      'phoneHash',case when status='new' then phone_hash end)); end if;
  end loop;
  context:=jsonb_build_object('workspaceId',p_workspace_id,'entries',seen);
  if octet_length(context::text)>4194304 then raise exception 'A prévia ultrapassou o limite seguro. Divida o arquivo.' using errcode='22023'; end if;
  return jsonb_build_object('new',new_count,'duplicate',duplicate_count,'conflict',conflict_count,'error',error_count,'results',results,'context',context);
end; $$;

create function public.import_external_leads(p_workspace_id uuid,p_records jsonb,p_source_namespace text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare
  raw jsonb; item jsonb; prepared jsonb:='[]'; results jsonb:='[]'; ids text[]; target_lead text; status text;
  imported integer:=0; skipped integer:=0; conflicts integer:=0;
begin
  -- All commercial writers share this tenant lock. A fresh statement snapshot
  -- after waiting sees committed manual, legacy and inbound leads as well.
  perform private.assert_external_import(p_workspace_id,p_records,p_source_namespace,true);
  for raw in select value from jsonb_array_elements(p_records) loop
    item:=private.prepare_external_import_record(p_workspace_id,raw,p_source_namespace);
    if item ? 'code' then
      raise exception 'Linha % inválida (%). Nenhum registro deste lote foi importado.',raw->>'rowNumber',item->>'code' using errcode='22023'; end if;
    prepared:=prepared||jsonb_build_array(item);
  end loop;
  for item in select value from jsonb_array_elements(prepared) loop
    ids:=private.external_import_matches(p_workspace_id,item,'[]');
    if cardinality(ids)>1 then status:='conflict'; conflicts:=conflicts+1;
    else
      if cardinality(ids)=1 then status:='duplicate'; skipped:=skipped+1; target_lead:=ids[1];
      else
        target_lead:=item->'lead'->>'id';
        insert into public.leads(workspace_id,id,owner_id,stage_id,data)
          values(p_workspace_id,target_lead,(item->>'ownerId')::uuid,(item->>'stageId')::uuid,item->'lead');
        -- Imported snapshots are not a reconstructed activity history. Keep
        -- only the genuine present-time creation; never simulate old calls,
        -- stage transitions, won/lost events, tasks or leadership reviews.
        delete from public.lead_events where workspace_id=p_workspace_id and lead_id=target_lead;
        perform private.add_lead_event(p_workspace_id,target_lead,'lead.created',jsonb_build_object('external_import',true,
          'owner_id',item->'ownerId','stage_id',item->'stageId','stage_name',item->'lead'->'stageName','stage_type',item->'lead'->'stageType','ticket',item->'lead'->'ticket'));
        status:='imported'; imported:=imported+1;
      end if;
      insert into private.external_import_keys(workspace_id,key_type,key_hash,lead_id) values(p_workspace_id,'row',item->>'rowKey',target_lead)
        on conflict(workspace_id,key_type,key_hash) do nothing;
      if item->>'sourceHash' is not null then
        insert into private.external_import_keys(workspace_id,key_type,key_hash,lead_id) values(p_workspace_id,'source',item->>'sourceHash',target_lead)
          on conflict(workspace_id,key_type,key_hash) do nothing; end if;
    end if;
    results:=results||jsonb_build_array(jsonb_build_object('rowNumber',item->'rowNumber','status',status));
  end loop;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'leads.external_imported',
    jsonb_build_object('imported',imported,'skipped',skipped,'conflicts',conflicts));
  return jsonb_build_object('imported',imported,'skipped',skipped,'conflicts',conflicts,'results',results);
end; $$;

revoke all on function private.cleanup_external_import_keys(),private.assert_external_import(uuid,jsonb,text,boolean),private.prepare_external_import_record(uuid,jsonb,text),
  private.external_import_matches(uuid,jsonb,jsonb),private.external_import_identity(uuid,text),private.external_import_preview_context(uuid,jsonb,integer),
  public.preview_import_leads(uuid,jsonb,text,jsonb),public.import_external_leads(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.preview_import_leads(uuid,jsonb,text,jsonb),public.import_external_leads(uuid,jsonb,text) to authenticated;
comment on function public.preview_import_leads(uuid,jsonb,text,jsonb) is 'Authorized tenant admin/manager only. Bounded row-status preview and hashed tenant-bound continuation. The write RPC never trusts preview state.';
comment on function public.import_external_leads(uuid,jsonb,text) is 'Atomic validated external import. Tenant-local contact/source/row deduplication, no merge or overwrite, no platform override or invented commercial history.';

commit;
