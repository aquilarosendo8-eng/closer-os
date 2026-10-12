-- Universal lead inbound. Installed migrations and existing lead payloads stay intact.
begin;

create function private.valid_inbound_mapping(p_mapping jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$ declare entry record;
begin
  if jsonb_typeof(p_mapping) is distinct from 'object' or not(p_mapping ? 'name') then return false; end if;
  for entry in select key,value from jsonb_each(p_mapping) loop
    if entry.key not in ('name','email','phone','company','ticket','source','notes')
      or jsonb_typeof(entry.value) is distinct from 'string'
      or length(btrim(entry.value#>>'{}')) not between 1 and 120
      or entry.value#>>'{}'<>btrim(entry.value#>>'{}')
      or entry.value#>>'{}' ~ '[[:cntrl:]]'
      or entry.value#>>'{}' in ('__proto__','prototype','constructor') then return false; end if;
  end loop;
  return true;
end; $$;

create table public.inbound_integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check(name=btrim(name) and length(name) between 2 and 120 and name !~ '[[:cntrl:]]' and name ~ '[^[:space:]]'),
  active boolean not null default true,
  archived_at timestamptz,
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  source text not null check(source=btrim(source) and length(source) between 1 and 120 and source !~ '[[:cntrl:]]' and source ~ '[^[:space:]]'),
  stage_id uuid,
  owner_id uuid,
  field_mapping jsonb not null check(private.valid_inbound_mapping(field_mapping)),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_received_at timestamptz,
  created_count bigint not null default 0 check(created_count between 0 and 9007199254740991),
  duplicate_count bigint not null default 0 check(duplicate_count between 0 and 9007199254740991),
  error_count bigint not null default 0 check(error_count between 0 and 9007199254740991),
  unique(workspace_id,id),
  foreign key(workspace_id,stage_id) references public.pipeline_stages(workspace_id,id) on delete set null(stage_id),
  foreign key(workspace_id,owner_id) references public.memberships(workspace_id,user_id) on delete set null(owner_id),
  check(archived_at is null or not active)
);
create index inbound_integrations_workspace_idx on public.inbound_integrations(workspace_id,created_at desc,id);
create trigger inbound_integration_touch before update on public.inbound_integrations for each row execute function private.touch_updated_at();

create table public.inbound_integration_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  integration_id uuid not null,
  request_id uuid not null,
  status text not null check(status in ('created','duplicate','rejected','error')),
  -- Operational references deliberately do not lock existing lead rows.
  lead_id text,
  duplicate_lead_id text,
  error_code text check(error_code in ('INVALID_BODY','BODY_TOO_LARGE','UNSUPPORTED_MEDIA_TYPE','UNSUPPORTED_ENCODING','BODY_TOO_DEEP','UNSAFE_PROPERTY',
    'WORKSPACE_UNAVAILABLE','STAGE_UNAVAILABLE','OWNER_UNAVAILABLE','NAME_REQUIRED','FIELD_INVALID','TICKET_INVALID','RATE_LIMITED','SERVICE_UNAVAILABLE','INVALID_CREDENTIALS')),
  http_status integer not null check(http_status between 200 and 599),
  retry_after integer check(retry_after between 1 and 86400),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_id,integration_id) references public.inbound_integrations(workspace_id,id) on delete cascade,
  unique(integration_id,request_id),
  check((status='created' and lead_id is not null and duplicate_lead_id is null and error_code is null)
    or (status='duplicate' and duplicate_lead_id is not null and lead_id is null and error_code is null)
    or (status in ('rejected','error') and lead_id is null and duplicate_lead_id is null and error_code is not null))
);
create index inbound_logs_cursor_idx on public.inbound_integration_logs(workspace_id,integration_id,id desc);
create index inbound_logs_retention_idx on public.inbound_integration_logs(created_at,id);

create table private.inbound_rate_limits (
  bucket_key text primary key,
  integration_id uuid references public.inbound_integrations(id) on delete cascade,
  window_start timestamptz not null,
  hits integer not null default 0 check(hits between 0 and 10001),
  updated_at timestamptz not null default clock_timestamp(),
  check((integration_id is null and bucket_key='global:minute')
    or (integration_id is not null and bucket_key in ('integration:'||integration_id::text||':minute','integration:'||integration_id::text||':day')))
);
alter table private.inbound_rate_limits enable row level security;
revoke all on private.inbound_rate_limits from public,anon,authenticated;
grant all on private.inbound_rate_limits to service_role;

-- Fixed-size hashes avoid B-tree key limits for long legacy contact strings.
-- No uniqueness constraint, data rewrite or new manual lead restriction.
create index leads_inbound_email_lookup_idx on public.leads(workspace_id,(extensions.digest(lower(btrim(data->>'email')),'sha256')))
  where nullif(btrim(data->>'email'),'') is not null;
create index leads_inbound_phone_lookup_idx on public.leads(workspace_id,(extensions.digest(regexp_replace(data->>'phone','[^0-9]','','g'),'sha256')))
  where regexp_replace(data->>'phone','[^0-9]','','g')<>'';

alter table public.lead_events drop constraint lead_events_event_type_check;
alter table public.lead_events add constraint lead_events_event_type_check check(event_type in (
  'lead.created','lead.owner_changed','lead.stage_changed','lead.ticket_changed',
  'call.scheduled','call.recorded','call.updated','call.recording_added','call.reviewed','call.snapshot',
  'activity.created','activity.updated','activity.completed','activity.cancelled',
  'lead.won','lead.lost','lead.reopened','lead.loss_reason_changed','lead.inbound_received'));

alter table public.inbound_integrations enable row level security;
alter table public.inbound_integration_logs enable row level security;
create policy inbound_integrations_read on public.inbound_integrations for select to authenticated
  using(private.workspace_role(workspace_id)='admin');
create policy inbound_logs_read on public.inbound_integration_logs for select to authenticated
  using(private.workspace_role(workspace_id)='admin');
revoke all on public.inbound_integrations,public.inbound_integration_logs from public,anon,authenticated;
-- The hash is excluded even from the administrator's table SELECT privileges.
grant select(id,workspace_id,name,active,archived_at,source,stage_id,owner_id,field_mapping,created_by,created_at,updated_at,last_received_at,created_count,duplicate_count,error_count)
  on public.inbound_integrations to authenticated;
grant select on public.inbound_integration_logs to authenticated;
grant all on public.inbound_integrations,public.inbound_integration_logs to service_role;
revoke all on public.inbound_integration_logs_id_seq from public,anon,authenticated;
grant usage,select on public.inbound_integration_logs_id_seq to service_role;

create function private.assert_inbound_admin(p_workspace_id uuid,p_lock boolean default false) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  if auth.uid() is null then raise exception 'Autenticação necessária.' using errcode='42501'; end if;
  if p_lock then perform 1 from public.workspaces where id=p_workspace_id for update;
  else perform 1 from public.workspaces where id=p_workspace_id; end if;
  if not found then raise exception 'Empresa não encontrada.' using errcode='P0002'; end if;
  if private.workspace_role(p_workspace_id) is distinct from 'admin' then
    raise exception 'Somente o administrador ativo desta empresa administra integrações.' using errcode='42501';
  end if;
end; $$;

create function private.inbound_integration_json(p_integration public.inbound_integrations) returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object(
  'id',p_integration.id,'workspace_id',p_integration.workspace_id,'name',p_integration.name,'active',p_integration.active,
  'archived_at',p_integration.archived_at,'source',p_integration.source,'stage_id',p_integration.stage_id,
  'stage_name',(select name from public.pipeline_stages where workspace_id=p_integration.workspace_id and id=p_integration.stage_id),
  'owner_id',p_integration.owner_id,'owner_name',private.effective_member_name(p_integration.workspace_id,p_integration.owner_id),
  'field_mapping',p_integration.field_mapping,'created_by',p_integration.created_by,'created_at',p_integration.created_at,
  'updated_at',p_integration.updated_at,'last_received_at',p_integration.last_received_at,
  'created_count',p_integration.created_count,'duplicate_count',p_integration.duplicate_count,'error_count',p_integration.error_count); $$;

create function private.validate_inbound_config(p_workspace_id uuid,p_name text,p_source text,p_stage_id uuid,p_owner_id uuid,p_mapping jsonb) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  if p_name is null or length(btrim(p_name)) not between 2 and 120 or p_name ~ '[[:cntrl:]]' or p_name !~ '[^[:space:]]'
    or p_source is null or length(btrim(p_source)) not between 1 and 120 or p_source ~ '[[:cntrl:]]' or p_source !~ '[^[:space:]]'
    or not private.valid_inbound_mapping(p_mapping) then raise exception 'Configuração da integração inválida.' using errcode='22023'; end if;
  if not exists(select 1 from public.pipeline_stages s join public.pipelines p on p.workspace_id=s.workspace_id and p.id=s.pipeline_id
    where s.workspace_id=p_workspace_id and s.id=p_stage_id and s.active and s.type='NORMAL' and p.is_default) then
    raise exception 'Selecione uma etapa normal ativa do pipeline desta empresa.' using errcode='23514'; end if;
  if not coalesce(private.assignable_owner(p_workspace_id,p_owner_id),false) then
    raise exception 'Selecione um responsável ativo com permissão de edição nesta empresa.' using errcode='23514'; end if;
end; $$;

create function public.list_inbound_integrations(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb; begin
  perform private.assert_inbound_admin(p_workspace_id);
  select coalesce(jsonb_agg(private.inbound_integration_json(i) order by i.created_at desc,i.id),'[]') into result
    from public.inbound_integrations i where i.workspace_id=p_workspace_id;
  return result;
end; $$;

create function public.create_inbound_integration(p_workspace_id uuid,p_name text,p_source text,p_stage_id uuid,p_owner_id uuid,p_field_mapping jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; raw_token text; selected_owner uuid:=coalesce(p_owner_id,auth.uid()); begin
  perform private.assert_inbound_admin(p_workspace_id,true);
  perform private.validate_inbound_config(p_workspace_id,p_name,p_source,p_stage_id,selected_owner,p_field_mapping);
  raw_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.inbound_integrations(workspace_id,name,source,stage_id,owner_id,field_mapping,token_hash,created_by)
    values(p_workspace_id,btrim(p_name),btrim(p_source),p_stage_id,selected_owner,p_field_mapping,encode(extensions.digest(raw_token,'sha256'),'hex'),auth.uid()) returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.created',jsonb_build_object('integration_id',item.id));
  return jsonb_build_object('integration',private.inbound_integration_json(item),'token',raw_token);
end; $$;

create function public.update_inbound_integration(p_workspace_id uuid,p_integration_id uuid,p_name text,p_source text,p_stage_id uuid,p_owner_id uuid,p_field_mapping jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; selected_owner uuid:=coalesce(p_owner_id,auth.uid()); begin
  perform private.assert_inbound_admin(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if item.archived_at is not null then raise exception 'Integração arquivada não pode ser editada.' using errcode='23514'; end if;
  perform private.validate_inbound_config(p_workspace_id,p_name,p_source,p_stage_id,selected_owner,p_field_mapping);
  update public.inbound_integrations set name=btrim(p_name),source=btrim(p_source),stage_id=p_stage_id,owner_id=selected_owner,field_mapping=p_field_mapping
    where id=item.id returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.updated',jsonb_build_object('integration_id',item.id));
  return private.inbound_integration_json(item);
end; $$;

create function private.inbound_payload_error(p_payload jsonb) returns text
language plpgsql immutable set search_path = ''
as $$ declare too_deep boolean; unsafe boolean; begin
  if jsonb_typeof(p_payload) is distinct from 'object' then return 'INVALID_BODY'; end if;
  if octet_length(p_payload::text)>65536 then return 'BODY_TOO_LARGE'; end if;
  with recursive nodes(value,depth,key) as (
    select p_payload,0,null::text
    union all
    select child.value,n.depth+1,child.key from nodes n cross join lateral (
      select value,key from jsonb_each(case when jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end)
      union all
      select value,null::text from jsonb_array_elements(case when jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end)
    ) child where n.depth<7
  ) select coalesce(bool_or(depth>6 and jsonb_typeof(value) in ('object','array')),false),
    coalesce(bool_or(key in ('__proto__','prototype','constructor')),false) into too_deep,unsafe from nodes;
  if too_deep then return 'BODY_TOO_DEEP'; end if;
  if unsafe then return 'UNSAFE_PROPERTY'; end if;
  return null;
end; $$;

create function private.take_inbound_quota(p_key text,p_integration_id uuid,p_period text,p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC'
as $$ declare bucket private.inbound_rate_limits; quota_window timestamptz; next_hits integer; retry integer; begin
  insert into private.inbound_rate_limits(bucket_key,integration_id,window_start) values(p_key,p_integration_id,clock_timestamp()) on conflict(bucket_key) do nothing;
  select * into bucket from private.inbound_rate_limits where bucket_key=p_key for update;
  -- Calculate the window after waiting for the persistent row, never rewind a
  -- current bucket using the timestamp of an earlier queued request.
  quota_window:=date_trunc(p_period,clock_timestamp());
  next_hits:=case when bucket.window_start=quota_window then least(bucket.hits+1,p_limit+1) else 1 end;
  update private.inbound_rate_limits set window_start=quota_window,hits=next_hits,updated_at=clock_timestamp() where bucket_key=p_key;
  retry:=greatest(1,ceil(extract(epoch from (quota_window+case p_period when 'day' then interval '1 day' else interval '1 minute' end)-clock_timestamp()))::integer);
  return jsonb_build_object('allowed',next_hits<=p_limit,'retry_after',least(retry,86400));
end; $$;

create function private.inbound_reply(p_status text,p_request_id uuid,p_http_status integer,p_error_code text default null,p_lead_id text default null,p_retry_after integer default null) returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_strip_nulls(jsonb_build_object('status',p_status,'request_id',p_request_id,'http_status',p_http_status,
  'error_code',p_error_code,'lead_id',p_lead_id,'retry_after',p_retry_after)); $$;

create function private.record_inbound_result(p_integration_id uuid,p_request_id uuid,p_status text,p_http_status integer,p_error_code text default null,p_lead_id text default null,p_retry_after integer default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare workspace uuid; begin
  select workspace_id into workspace from public.inbound_integrations where id=p_integration_id;
  -- Represent quota rejections once per minute, while cumulative counters
  -- count attempts. Otherwise an exhausted credential would amplify logs.
  if p_error_code is distinct from 'RATE_LIMITED' or not exists(select 1 from public.inbound_integration_logs
    where integration_id=p_integration_id and error_code='RATE_LIMITED' and created_at>=date_trunc('minute',clock_timestamp())) then
    insert into public.inbound_integration_logs(workspace_id,integration_id,request_id,status,lead_id,duplicate_lead_id,error_code,http_status,retry_after)
      values(workspace,p_integration_id,p_request_id,p_status,case when p_status='created' then p_lead_id end,
        case when p_status='duplicate' then p_lead_id end,p_error_code,p_http_status,p_retry_after);
  end if;
  update public.inbound_integrations set last_received_at=clock_timestamp(),
    created_count=least(created_count+case when p_status='created' then 1 else 0 end,9007199254740991),
    duplicate_count=least(duplicate_count+case when p_status='duplicate' then 1 else 0 end,9007199254740991),
    error_count=least(error_count+case when p_status in ('error','rejected') then 1 else 0 end,9007199254740991)
    where id=p_integration_id;
  return private.inbound_reply(p_status,p_request_id,p_http_status,p_error_code,p_lead_id,p_retry_after);
end; $$;

create function public.purge_inbound_integration_logs(p_limit integer default 5000) returns integer
language plpgsql security definer set search_path = ''
as $$ declare removed integer; begin
  if p_limit is null or p_limit not between 1 and 20000 then raise exception 'Limite de limpeza inválido.' using errcode='22023'; end if;
  delete from public.inbound_integration_logs where id in (select id from public.inbound_integration_logs
    where created_at<clock_timestamp()-interval '90 days' order by created_at,id limit p_limit);
  get diagnostics removed=row_count;
  delete from private.inbound_rate_limits where bucket_key in (select bucket_key from private.inbound_rate_limits
    where integration_id is not null and updated_at<clock_timestamp()-interval '2 days' order by updated_at limit p_limit for update skip locked)
    and updated_at<clock_timestamp()-interval '2 days';
  return removed;
end; $$;

create function public.receive_inbound_lead(p_token_hash text,p_request_id uuid,p_payload jsonb,p_transport_error text default null) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC'
as $$
declare
  workspace uuid; integration_id uuid; item public.inbound_integrations; prior public.inbound_integration_logs;
  global_quota jsonb; minute_quota jsonb; day_quota jsonb; retry integer;
  mapped jsonb:='{}'; field text; value jsonb; text_value text; problem text; http_status integer;
  normalized_email text; normalized_phone text; phone text; ticket numeric:=0; stage public.pipeline_stages;
  lead_id text; stamp text; lead_data jsonb;
begin
  -- The endpoint uses a fresh server-key client without a user session. Reject
  -- inherited user identities; never rewrite Supabase's protected JWT settings.
  -- Existing lead/audit/timeline triggers then naturally attribute automation
  -- to NULL, while EXECUTE remains exclusively granted to service_role.
  if auth.uid() is not null then return private.inbound_reply('rejected',p_request_id,401,'INVALID_CREDENTIALS'); end if;
  global_quota:=private.take_inbound_quota('global:minute',null,'minute',5000);
  if not (global_quota->>'allowed')::boolean then return private.inbound_reply('rejected',p_request_id,429,'RATE_LIMITED',null,(global_quota->>'retry_after')::integer); end if;
  if p_request_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    return private.inbound_reply('rejected',p_request_id,401,'INVALID_CREDENTIALS');
  end if;
  select i.workspace_id,i.id into workspace,integration_id from public.inbound_integrations i where i.token_hash=p_token_hash;
  if integration_id is null then return private.inbound_reply('rejected',p_request_id,401,'INVALID_CREDENTIALS'); end if;
  perform 1 from public.workspaces where id=workspace for update;
  if not found then return private.inbound_reply('rejected',p_request_id,401,'INVALID_CREDENTIALS'); end if;
  select * into item from public.inbound_integrations where id=integration_id and workspace_id=workspace and token_hash=p_token_hash for update;
  if not found then return private.inbound_reply('rejected',p_request_id,401,'INVALID_CREDENTIALS'); end if;
  if not item.active or item.archived_at is not null then
    -- Do not distinguish disabled, archived and unknown credentials publicly.
    return private.inbound_reply('rejected',p_request_id,401,'INVALID_CREDENTIALS');
  end if;
  -- A committed request can be retried without creating another lead, event,
  -- operational log or integration counter. Credentials are checked first.
  select * into prior from public.inbound_integration_logs l where l.integration_id=item.id and l.request_id=p_request_id;
  if found then return private.inbound_reply(prior.status,p_request_id,prior.http_status,prior.error_code,coalesce(prior.lead_id,prior.duplicate_lead_id),prior.retry_after); end if;
  minute_quota:=private.take_inbound_quota('integration:'||item.id::text||':minute',item.id,'minute',120);
  day_quota:=private.take_inbound_quota('integration:'||item.id::text||':day',item.id,'day',10000);
  if not (minute_quota->>'allowed')::boolean or not (day_quota->>'allowed')::boolean then
    retry:=greatest(case when not (minute_quota->>'allowed')::boolean then (minute_quota->>'retry_after')::integer else 1 end,
      case when not (day_quota->>'allowed')::boolean then (day_quota->>'retry_after')::integer else 1 end);
    return private.record_inbound_result(item.id,p_request_id,'rejected',429,'RATE_LIMITED',null,retry);
  end if;
  perform public.purge_inbound_integration_logs(100);
  if not private.workspace_available(workspace) then return private.record_inbound_result(item.id,p_request_id,'rejected',403,'WORKSPACE_UNAVAILABLE'); end if;
  select s.* into stage from public.pipeline_stages s join public.pipelines p on p.workspace_id=s.workspace_id and p.id=s.pipeline_id
    where s.workspace_id=workspace and s.id=item.stage_id and s.active and s.type='NORMAL' and p.is_default;
  if not found then return private.record_inbound_result(item.id,p_request_id,'rejected',409,'STAGE_UNAVAILABLE'); end if;
  if not coalesce(private.assignable_owner(workspace,item.owner_id),false) then return private.record_inbound_result(item.id,p_request_id,'rejected',409,'OWNER_UNAVAILABLE'); end if;
  if p_transport_error is not null then
    problem:=case when p_transport_error in ('INVALID_BODY','BODY_TOO_LARGE','UNSUPPORTED_MEDIA_TYPE','UNSUPPORTED_ENCODING','BODY_TOO_DEEP','UNSAFE_PROPERTY') then p_transport_error else 'INVALID_BODY' end;
  else problem:=private.inbound_payload_error(p_payload); end if;
  if problem is not null then
    http_status:=case problem when 'BODY_TOO_LARGE' then 413 when 'UNSUPPORTED_MEDIA_TYPE' then 415 when 'UNSUPPORTED_ENCODING' then 415 else 400 end;
    return private.record_inbound_result(item.id,p_request_id,'rejected',http_status,problem);
  end if;
  foreach field in array array['name','email','phone','company','ticket','source','notes'] loop
    value:=case when item.field_mapping ? field then p_payload->(item.field_mapping->>field) else null end;
    if field='ticket' then
      if value is null or jsonb_typeof(value)='null' or (jsonb_typeof(value)='string' and btrim(value#>>'{}')='') then ticket:=0;
      elsif jsonb_typeof(value)='number' then ticket:=(value#>>'{}')::numeric;
      elsif jsonb_typeof(value)='string' and length(value#>>'{}')<=80 and btrim(value#>>'{}') ~ '^[0-9]+(\.[0-9]+)?$' then ticket:=btrim(value#>>'{}')::numeric;
      else return private.record_inbound_result(item.id,p_request_id,'rejected',422,'TICKET_INVALID'); end if;
      if ticket<0 or ticket>1000000000000 then return private.record_inbound_result(item.id,p_request_id,'rejected',422,'TICKET_INVALID'); end if;
    else
      if value is null or jsonb_typeof(value)='null' then text_value:='';
      elsif jsonb_typeof(value)='string' then text_value:=case when field='notes' then value#>>'{}' else btrim(value#>>'{}') end;
      else return private.record_inbound_result(item.id,p_request_id,'rejected',422,'FIELD_INVALID'); end if;
      if field='name' and (text_value='' or text_value !~ '[^[:space:]]') then return private.record_inbound_result(item.id,p_request_id,'rejected',422,'NAME_REQUIRED'); end if;
      if length(text_value)>(case field when 'name' then 200 when 'company' then 200 when 'email' then 254 when 'phone' then 64 when 'source' then 120 else 10000 end)
        or (field<>'notes' and text_value ~ '[[:cntrl:]]') then return private.record_inbound_result(item.id,p_request_id,'rejected',422,'FIELD_INVALID'); end if;
      mapped:=mapped||jsonb_build_object(field,text_value);
    end if;
  end loop;
  normalized_email:=lower(btrim(mapped->>'email'));
  if normalized_email<>'' and normalized_email !~ '^[^[:space:]@<>"\\]+@[^[:space:]@<>"\\]+\.[^[:space:]@<>"\\]+$' then
    return private.record_inbound_result(item.id,p_request_id,'rejected',422,'FIELD_INVALID'); end if;
  phone:=mapped->>'phone'; normalized_phone:=regexp_replace(phone,'[^0-9]','','g');
  if phone<>'' and (phone !~ '^[0-9+(). /-]+$' or normalized_phone='' or length(normalized_phone)>32) then return private.record_inbound_result(item.id,p_request_id,'rejected',422,'FIELD_INVALID'); end if;
  phone:=case when left(phone,1)='+' and normalized_phone<>'' then '+'||normalized_phone else normalized_phone end;
  -- A separate SQL statement after acquiring the tenant lock gets a fresh
  -- READ COMMITTED snapshot, including manual leads committed while waiting.
  -- Do not lock existing leads: direct UPDATE locks lead before its trigger.
  select l.id into lead_id from public.leads l where l.workspace_id=workspace and
    ((normalized_phone<>'' and regexp_replace(l.data->>'phone','[^0-9]','','g')<>''
      and extensions.digest(regexp_replace(l.data->>'phone','[^0-9]','','g'),'sha256')=extensions.digest(normalized_phone,'sha256')
      and regexp_replace(l.data->>'phone','[^0-9]','','g')=normalized_phone)
    or (normalized_email<>'' and nullif(btrim(l.data->>'email'),'') is not null
      and extensions.digest(lower(btrim(l.data->>'email')),'sha256')=extensions.digest(normalized_email,'sha256')
      and lower(btrim(l.data->>'email'))=normalized_email))
    order by (normalized_phone<>'' and regexp_replace(l.data->>'phone','[^0-9]','','g')=normalized_phone) desc,l.created_at,l.id limit 1;
  if found then return private.record_inbound_result(item.id,p_request_id,'duplicate',200,null,lead_id); end if;
  lead_id:=gen_random_uuid()::text;
  stamp:=to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  lead_data:=jsonb_build_object('id',lead_id,'name',mapped->>'name','company',mapped->>'company','email',normalized_email,'phone',phone,
    'ticket',ticket,'source',coalesce(nullif(mapped->>'source',''),item.source),'createdAt',stamp,'callDate','','attendance','Pendente',
    'objection','','status',stage.legacy_status,'closedValue',0,'closedAt','','lastContactAt',stamp,'notes',mapped->>'notes',
    'pain','','urgency','Baixa','financialCapacity','Não avaliada','decisionMaker',false,'callScore',null,'closerError','','callSummary','',
    'recordingUrl','','nextStep','','lossReason','','lossComment','');
  begin
    insert into public.leads(workspace_id,id,owner_id,stage_id,data) values(workspace,lead_id,item.owner_id,stage.id,lead_data);
    perform private.add_lead_event(workspace,lead_id,'lead.inbound_received',jsonb_build_object('integration_id',item.id,'integration_name',item.name,'source',lead_data->>'source'));
    return private.record_inbound_result(item.id,p_request_id,'created',201,null,lead_id);
  exception when others then
    -- This subtransaction rolls back both the lead and all its audit/timeline
    -- writes. Rate consumption survives; only a safe error code is recorded.
    return private.record_inbound_result(item.id,p_request_id,'error',503,'SERVICE_UNAVAILABLE');
  end;
end; $$;

create function public.set_inbound_integration_active(p_workspace_id uuid,p_integration_id uuid,p_active boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; begin
  perform private.assert_inbound_admin(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if p_active is null or (p_active and item.archived_at is not null) then raise exception 'Estado da integração inválido.' using errcode='23514'; end if;
  if p_active then perform private.validate_inbound_config(p_workspace_id,item.name,item.source,item.stage_id,item.owner_id,item.field_mapping); end if;
  update public.inbound_integrations set active=p_active where id=item.id returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.status_updated',jsonb_build_object('integration_id',item.id,'active',p_active));
  return private.inbound_integration_json(item);
end; $$;

create function public.rotate_inbound_integration_token(p_workspace_id uuid,p_integration_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; raw_token text; begin
  perform private.assert_inbound_admin(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if item.archived_at is not null then raise exception 'Integração arquivada não pode redefinir credencial.' using errcode='23514'; end if;
  raw_token:=encode(extensions.gen_random_bytes(32),'hex');
  update public.inbound_integrations set token_hash=encode(extensions.digest(raw_token,'sha256'),'hex') where id=item.id returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.token_rotated',jsonb_build_object('integration_id',item.id));
  return jsonb_build_object('integration',private.inbound_integration_json(item),'token',raw_token);
end; $$;

create function public.archive_inbound_integration(p_workspace_id uuid,p_integration_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; begin
  perform private.assert_inbound_admin(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if item.archived_at is null then
    update public.inbound_integrations set active=false,archived_at=clock_timestamp() where id=item.id returning * into item;
    insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.archived',jsonb_build_object('integration_id',item.id));
  end if;
  return private.inbound_integration_json(item);
end; $$;

create function public.list_inbound_integration_logs(p_workspace_id uuid,p_integration_id uuid,p_before_id bigint default null,p_limit integer default 30) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare items jsonb; last_id bigint; more boolean; begin
  perform private.assert_inbound_admin(p_workspace_id);
  if not exists(select 1 from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id) then
    raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_id is not null and p_before_id<=0) then raise exception 'Paginação inválida.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id::text,'workspace_id',l.workspace_id,'integration_id',l.integration_id,'request_id',l.request_id,
    'status',l.status,'lead_id',l.lead_id,'duplicate_lead_id',l.duplicate_lead_id,'error_code',l.error_code,'created_at',l.created_at) order by l.id desc),'[]'),min(l.id)
    into items,last_id from (select * from public.inbound_integration_logs where workspace_id=p_workspace_id and integration_id=p_integration_id
      and (p_before_id is null or id<p_before_id) order by id desc limit p_limit) l;
  select exists(select 1 from public.inbound_integration_logs where workspace_id=p_workspace_id and integration_id=p_integration_id and id<last_id) into more;
  return jsonb_build_object('items',items,'next_cursor',case when more then last_id::text else null end);
end; $$;

create or replace function public.export_workspace(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb; begin
  -- Preserve the existing administrator-only portability access on paused plans.
  if auth.uid() is null or private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Somente o administrador da empresa exporta o workspace.' using errcode='42501'; end if;
  select jsonb_build_object('version',1,'exported_at',now(),'workspace_id',p_workspace_id,
    'leads',coalesce((select jsonb_agg(data order by created_at) from public.leads where workspace_id=p_workspace_id),'[]'),
    'pipelines',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'is_default',is_default,'created_at',created_at)) from public.pipelines where workspace_id=p_workspace_id),'[]'),
    'pipeline_stages',coalesce((select jsonb_agg(jsonb_build_object('id',id,'pipeline_id',pipeline_id,'name',name,'position',position,'color',color,'type',type,'active',active) order by position) from public.pipeline_stages where workspace_id=p_workspace_id),'[]'),
    'call_reviews',coalesce((select jsonb_agg(jsonb_build_object('lead_id',lead_id,'feedback',feedback,'score',score,'reviewed_by',reviewed_by,'reviewed_at',reviewed_at)) from public.call_reviews where workspace_id=p_workspace_id),'[]'),
    'activities',coalesce((select jsonb_agg(to_jsonb(a) order by a.due_at,a.id) from public.activities a where workspace_id=p_workspace_id),'[]'),
    'lead_events',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('id',e.id::text) order by e.id) from public.lead_events e where workspace_id=p_workspace_id),'[]'),
    'inbound_integrations',coalesce((select jsonb_agg(private.inbound_integration_json(i) order by i.created_at,i.id) from public.inbound_integrations i where workspace_id=p_workspace_id),'[]'),
    'inbound_integration_logs',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('id',l.id::text) order by l.id) from public.inbound_integration_logs l where workspace_id=p_workspace_id),'[]'),
    'settings',jsonb_build_object('name',s.name,'commissionRate',s.commission_rate,'revenueGoal',s.revenue_goal),
    'privacy',jsonb_build_object('retention_days',w.retention_days,'privacy_contact_email',w.privacy_contact_email),
    'lead_privacy',coalesce((select jsonb_agg(jsonb_build_object('id',id,'owner_id',owner_id,'lawful_basis',lawful_basis,'consent_at',consent_at,'retention_until',retention_until)) from public.leads where workspace_id=p_workspace_id),'[]')) into result
    from public.workspaces w join public.workspace_settings s on s.workspace_id=w.id where w.id=p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.exported');
  return result;
end; $$;

revoke all on function private.valid_inbound_mapping(jsonb),private.assert_inbound_admin(uuid,boolean),private.inbound_integration_json(public.inbound_integrations),
  private.validate_inbound_config(uuid,text,text,uuid,uuid,jsonb),private.inbound_payload_error(jsonb),private.take_inbound_quota(text,uuid,text,integer),
  private.inbound_reply(text,uuid,integer,text,text,integer),private.record_inbound_result(uuid,uuid,text,integer,text,text,integer) from public,anon,authenticated;
grant execute on function private.valid_inbound_mapping(jsonb),private.assert_inbound_admin(uuid,boolean),private.inbound_integration_json(public.inbound_integrations),
  private.validate_inbound_config(uuid,text,text,uuid,uuid,jsonb),private.inbound_payload_error(jsonb),private.take_inbound_quota(text,uuid,text,integer),
  private.inbound_reply(text,uuid,integer,text,text,integer),private.record_inbound_result(uuid,uuid,text,integer,text,text,integer) to service_role;
revoke all on function public.list_inbound_integrations(uuid),public.create_inbound_integration(uuid,text,text,uuid,uuid,jsonb),
  public.update_inbound_integration(uuid,uuid,text,text,uuid,uuid,jsonb),public.set_inbound_integration_active(uuid,uuid,boolean),
  public.rotate_inbound_integration_token(uuid,uuid),public.archive_inbound_integration(uuid,uuid),public.list_inbound_integration_logs(uuid,uuid,bigint,integer)
  from public,anon,authenticated;
grant execute on function public.list_inbound_integrations(uuid),public.create_inbound_integration(uuid,text,text,uuid,uuid,jsonb),
  public.update_inbound_integration(uuid,uuid,text,text,uuid,uuid,jsonb),public.set_inbound_integration_active(uuid,uuid,boolean),
  public.rotate_inbound_integration_token(uuid,uuid),public.archive_inbound_integration(uuid,uuid),public.list_inbound_integration_logs(uuid,uuid,bigint,integer)
  to authenticated,service_role;
revoke all on function public.receive_inbound_lead(text,uuid,jsonb,text),public.purge_inbound_integration_logs(integer) from public,anon,authenticated;
grant execute on function public.receive_inbound_lead(text,uuid,jsonb,text),public.purge_inbound_integration_logs(integer) to service_role;

comment on table public.inbound_integrations is 'Administrator-managed webhook configuration. Only SHA-256 credentials persist; plaintext is returned once on create/rotate, excluded from reads and exports.';
comment on table public.inbound_integration_logs is '90-day operational metadata only, without payloads, contacts or credentials. Lead references are non-locking operational IDs; cumulative counters survive log retention.';
comment on table private.inbound_rate_limits is 'Service-only persistent fixed UTC windows: global 5000/minute, integration 120/minute and 10000/day. Fixed global key prevents unknown-token bucket amplification.';
comment on function public.receive_inbound_lead(text,uuid,jsonb,text) is 'Server-only atomic authenticated integration mapping, validation, quotas, tenant-local deduplication, normal lead creation and safe operational history. External payload never chooses tenant, stage, owner, identity or timestamps.';
comment on function public.purge_inbound_integration_logs(integer) is 'Service-only bounded cleanup of 90-day logs and idle 2-day quota buckets. Ingestion also runs a bounded lazy cleanup. Configure a scheduler if cleanup is needed without incoming traffic.';
notify pgrst,'reload schema';
commit;
