-- One configurable default pipeline per tenant; recordings and independent leadership reviews.
-- Prior migrations remain byte-for-byte unchanged. Backfill preserves lead payloads and timestamps.
begin;

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null default 'Pipeline principal' check(length(btrim(name)) between 2 and 80),
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  unique(workspace_id,id)
);
create unique index pipelines_default_workspace_idx on public.pipelines(workspace_id) where is_default;
create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  pipeline_id uuid not null,
  name text not null check(length(btrim(name)) between 2 and 80 and name=btrim(name) and name !~ '[[:cntrl:]]'),
  position integer not null check(position between 0 and 39),
  color text not null check(color ~ '^#[0-9a-fA-F]{6}$'),
  type text not null check(type in ('NORMAL','WON','LOST')),
  active boolean not null default true,
  legacy_status text not null default 'Qualificado' check(legacy_status in ('Lead novo','Qualificado','Call agendada','Compareceu','Follow-up','Fechado','Perdido')),
  created_at timestamptz not null default now(),
  foreign key(workspace_id,pipeline_id) references public.pipelines(workspace_id,id) on delete cascade,
  unique(workspace_id,id),
  unique(pipeline_id,position) deferrable initially deferred
);
create index pipeline_stages_workspace_idx on public.pipeline_stages(workspace_id,pipeline_id,position);

create function private.create_default_pipeline() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare pipeline uuid;
begin
  insert into public.pipelines(workspace_id) values(new.id) returning id into pipeline;
  insert into public.pipeline_stages(workspace_id,pipeline_id,name,position,color,type,legacy_status)
  select new.id,pipeline,s.name,s.position,s.color,s.type,s.name
    from (values ('Lead novo',0,'#64748b','NORMAL'),('Qualificado',1,'#8b5cf6','NORMAL'),
      ('Call agendada',2,'#3b82f6','NORMAL'),('Compareceu',3,'#06b6d4','NORMAL'),
      ('Follow-up',4,'#f59e0b','NORMAL'),('Fechado',5,'#10b981','WON'),('Perdido',6,'#ef4444','LOST')) s(name,position,color,type);
  return new;
end; $$;
create trigger workspace_pipeline_defaults after insert on public.workspaces for each row execute function private.create_default_pipeline();
-- Existing workspaces receive identical default stages without touching their owner/settings.
insert into public.pipelines(workspace_id) select id from public.workspaces;
insert into public.pipeline_stages(workspace_id,pipeline_id,name,position,color,type,legacy_status)
select p.workspace_id,p.id,s.name,s.position,s.color,s.type,s.name from public.pipelines p
cross join (values ('Lead novo',0,'#64748b','NORMAL'),('Qualificado',1,'#8b5cf6','NORMAL'),
 ('Call agendada',2,'#3b82f6','NORMAL'),('Compareceu',3,'#06b6d4','NORMAL'),
 ('Follow-up',4,'#f59e0b','NORMAL'),('Fechado',5,'#10b981','WON'),('Perdido',6,'#ef4444','LOST')) s(name,position,color,type);

alter table public.leads add column stage_id uuid;
alter table public.leads add column loss_reason_grandfathered boolean not null default false;
alter table public.leads disable trigger lead_prepare;
alter table public.leads disable trigger lead_audit;
update public.leads l set stage_id=s.id,
  data=l.data || jsonb_build_object('stageId',s.id,'stageName',s.name,'stageType',s.type),
  loss_reason_grandfathered=(s.type='LOST' and coalesce(l.data->>'lossReason','')='')
from public.pipeline_stages s where s.workspace_id=l.workspace_id and s.legacy_status=l.data->>'status';
alter table public.leads enable trigger lead_prepare;
alter table public.leads enable trigger lead_audit;
alter table public.leads alter column stage_id set not null;
alter table public.leads add constraint leads_stage_tenant_fk foreign key(workspace_id,stage_id)
  references public.pipeline_stages(workspace_id,id) on delete restrict;
create index leads_stage_idx on public.leads(workspace_id,stage_id);

create table public.call_reviews (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null,
  feedback text not null check(length(btrim(feedback)) between 1 and 10000),
  score integer not null check(score between 0 and 10),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz not null default now(),
  primary key(workspace_id,lead_id),
  foreign key(workspace_id,lead_id) references public.leads(workspace_id,id) on delete cascade
);

create function private.valid_recording_url(p_url text) returns boolean
language plpgsql immutable set search_path = ''
as $$ declare authority text; host text;
begin
  if p_url='' then return true; end if;
  if p_url is null or length(p_url)>4096 or p_url !~* '^https://' or p_url ~ '[[:space:][:cntrl:]]' or position(chr(92) in p_url)>0
    or lower(p_url) ~ '%(0[0-9a-f]|1[0-9a-f]|7f|5c)' then return false; end if;
  authority:=substring(p_url from '(?i)^https://([^/?#]+)');
  if authority is null or position('@' in authority)>0 then return false; end if;
  -- Bracketed IPv6 is allowed; other hosts contain only DNS/IP characters and an optional valid port.
  if authority ~ '^\[[0-9a-fA-F:]+\](:[0-9]{1,5})?$' then
    host:=substring(authority from '^\[([^]]+)\]');
    perform host::inet;
  elsif authority !~ '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.?(:[0-9]{1,5})?$' then return false;
  end if;
  if authority ~ ':[0-9]+$' and substring(authority from ':([0-9]+)$')::integer not between 1 and 65535 then return false; end if;
  return true;
exception when others then return false;
end; $$;

create function private.valid_legacy_lead_data(p_data jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare field text; value text; numeric_value numeric;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 262144 then return false; end if;
  foreach field in array array['id','name','company','email','phone','source','createdAt','callDate','objection','closedAt','lastContactAt','notes','pain','closerError','callSummary'] loop
    if jsonb_typeof(p_data -> field) is distinct from 'string' then return false; end if;
  end loop;
  if length(p_data ->> 'id') not between 1 and 200 or length(btrim(p_data ->> 'name')) not between 1 and 200 then return false; end if;
  if (p_data ->> 'status') is null or (p_data ->> 'status') not in ('Lead novo','Qualificado','Call agendada','Compareceu','Follow-up','Fechado','Perdido') then return false; end if;
  if (p_data ->> 'attendance') is null or (p_data ->> 'attendance') not in ('Pendente','Compareceu','Não compareceu') then return false; end if;
  if (p_data ->> 'urgency') is null or (p_data ->> 'urgency') not in ('Baixa','Média','Alta') then return false; end if;
  if (p_data ->> 'financialCapacity') is null or (p_data ->> 'financialCapacity') not in ('Não avaliada','Baixa','Média','Alta') then return false; end if;
  if jsonb_typeof(p_data -> 'decisionMaker') is distinct from 'boolean' then return false; end if;
  foreach field in array array['ticket','closedValue'] loop
    if jsonb_typeof(p_data -> field) is distinct from 'number' then return false; end if;
    numeric_value := (p_data ->> field)::numeric;
    if numeric_value < 0 or numeric_value > 1000000000000 then return false; end if;
  end loop;
  if p_data -> 'callScore' is null then return false; end if;
  if jsonb_typeof(p_data -> 'callScore') <> 'null' then
    if jsonb_typeof(p_data -> 'callScore') <> 'number' then return false; end if;
    numeric_value := (p_data ->> 'callScore')::numeric;
    if numeric_value < 0 or numeric_value > 10 or numeric_value <> trunc(numeric_value) then return false; end if;
  end if;
  foreach field in array array['createdAt','callDate','closedAt','lastContactAt'] loop
    value := p_data ->> field;
    if value = '' then
      if field in ('createdAt','lastContactAt') then return false; end if;
    else
      if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then return false; end if;
      perform value::timestamptz;
    end if;
  end loop;
  if p_data ->> 'status' = 'Fechado' and ((p_data ->> 'closedValue')::numeric <= 0 or p_data ->> 'closedAt' = '' or p_data ->> 'attendance' <> 'Compareceu') then return false; end if;
  return true;
exception when others then return false;
end; $$;
create or replace function private.valid_lead_data(p_data jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$ declare field text;
begin
  if not private.valid_legacy_lead_data(p_data) then return false; end if;
  foreach field in array array['recordingUrl','nextStep','lossReason','lossComment'] loop
    if p_data ? field and jsonb_typeof(p_data->field) is distinct from 'string' then return false; end if;
  end loop;
  if p_data ? 'recordingUrl' and not private.valid_recording_url(p_data->>'recordingUrl') then return false; end if;
  if length(coalesce(p_data->>'nextStep',''))>10000 or length(coalesce(p_data->>'lossComment',''))>4000 then return false; end if;
  if coalesce(p_data->>'lossReason','') not in ('','Investimento','Sem urgência','Sem capacidade financeira','Decisor não participou','Escolheu concorrente','Timing','Sumiu','Não percebeu valor','Outro') then return false; end if;
  return true;
end; $$;

create or replace function private.prepare_lead() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare stage public.pipeline_stages%rowtype; target uuid; old_type text;
begin
  perform 1 from public.workspaces where id=new.workspace_id for update;
  if tg_op='UPDATE' and (new.workspace_id<>old.workspace_id or new.id<>old.id) then
    raise exception 'Não é possível mover um registro entre workspaces ou alterar seu ID.' using errcode='42501';
  end if;
  target:=new.stage_id;
  if tg_op='INSERT' and target is null then
    if nullif(new.data->>'stageId','') is not null then target:=(new.data->>'stageId')::uuid;
    else select id into target from public.pipeline_stages where workspace_id=new.workspace_id and active
      order by (legacy_status=new.data->>'status') desc,(type='NORMAL') desc,position limit 1; end if;
  elsif tg_op='UPDATE' and new.stage_id=old.stage_id then
    if nullif(new.data->>'stageId','') is not null and new.data->>'stageId' is distinct from old.data->>'stageId' then target:=(new.data->>'stageId')::uuid;
    elsif not(new.data ? 'stageId') and new.data->>'status' is distinct from old.data->>'status' then
      select id into target from public.pipeline_stages where workspace_id=new.workspace_id and active
        and ((new.data->>'status'='Fechado' and type='WON') or (new.data->>'status'='Perdido' and type='LOST')
          or (new.data->>'status' not in ('Fechado','Perdido') and type='NORMAL'))
        order by (legacy_status=new.data->>'status') desc,position limit 1;
    end if;
  end if;
  select * into stage from public.pipeline_stages where workspace_id=new.workspace_id and id=target for key share;
  if stage.id is null then raise exception 'Etapa inválida para esta empresa.' using errcode='23514'; end if;
  if not stage.active and (tg_op='INSERT' or target is distinct from old.stage_id) then raise exception 'Esta etapa está desativada.' using errcode='23514'; end if;
  if stage.type='LOST' and nullif(btrim(new.data->>'lossReason'),'') is null
    and not ((tg_op='INSERT' and new.loss_reason_grandfathered)
      or (tg_op='UPDATE' and old.loss_reason_grandfathered and target=old.stage_id)) then
    raise exception 'Informe o motivo da perda.' using errcode='23514';
  end if;
  if stage.type='WON' then
    if jsonb_typeof(new.data->'closedValue') is distinct from 'number' or (new.data->>'closedValue')::numeric<=0 then raise exception 'Informe um valor fechado positivo.' using errcode='23514'; end if;
    new.data:=new.data || jsonb_build_object('attendance','Compareceu','closedAt',coalesce(nullif(new.data->>'closedAt',''),to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  new.stage_id:=stage.id;
  new.data:=(new.data-'leadershipReview') || jsonb_build_object('stageId',stage.id,'stageName',stage.name,'stageType',stage.type,
    'status',case stage.type when 'WON' then 'Fechado' when 'LOST' then 'Perdido' else stage.legacy_status end);
  if tg_op='INSERT' then
    new.created_at:=now(); new.created_by:=auth.uid();
    new.loss_reason_grandfathered:=new.loss_reason_grandfathered and stage.type='LOST' and nullif(btrim(new.data->>'lossReason'),'') is null;
    if new.retention_until is null then select now()+(retention_days*interval '1 day') into new.retention_until from public.workspaces where id=new.workspace_id; end if;
  else
    new.created_at:=old.created_at; new.created_by:=old.created_by;
    new.loss_reason_grandfathered:=old.loss_reason_grandfathered and stage.type='LOST' and target=old.stage_id and nullif(btrim(new.data->>'lossReason'),'') is null;
  end if;
  new.updated_at:=now(); new.updated_by:=auth.uid();
  return new;
exception when invalid_text_representation then raise exception 'Etapa ou valor inválido.' using errcode='22023';
end; $$;

alter table public.pipelines enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.call_reviews enable row level security;
create policy pipelines_read on public.pipelines for select to authenticated using(private.workspace_available(workspace_id) and private.workspace_role(workspace_id) is not null);
create policy pipeline_stages_read on public.pipeline_stages for select to authenticated using(private.workspace_available(workspace_id) and private.workspace_role(workspace_id) is not null);
create policy call_reviews_read on public.call_reviews for select to authenticated using(exists(select 1 from public.leads l where l.workspace_id=call_reviews.workspace_id and l.id=call_reviews.lead_id and private.can_read_lead(l.workspace_id,l.owner_id)));

create function public.list_pipeline_stages(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or private.workspace_role(p_workspace_id) is null or not private.workspace_available(p_workspace_id) then raise exception 'Pipeline não autorizado.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'pipeline_id',s.pipeline_id,'name',s.name,'position',s.position,'color',s.color,'type',s.type,'active',s.active,
    'lead_count',(select count(*) from public.leads l where l.workspace_id=s.workspace_id and l.stage_id=s.id and private.can_read_lead(l.workspace_id,l.owner_id))) order by s.position),'[]') into result
    from public.pipeline_stages s join public.pipelines p on p.id=s.pipeline_id and p.workspace_id=s.workspace_id where s.workspace_id=p_workspace_id and p.is_default;
  return result;
end; $$;

create function public.save_pipeline_stages(p_workspace_id uuid,p_stages jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare pipeline uuid; item jsonb; ids uuid[]:='{}'; target uuid; position integer:=0; previous public.pipeline_stages%rowtype;
begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if auth.uid() is null or private.workspace_role(p_workspace_id) not in ('admin','manager') or private.workspace_role(p_workspace_id) is null then raise exception 'Somente admin e manager configuram o pipeline.' using errcode='42501'; end if;
  perform private.assert_available(p_workspace_id);
  if jsonb_typeof(p_stages) is distinct from 'array' or jsonb_array_length(p_stages) not between 2 and 40 then raise exception 'Envie entre 2 e 40 etapas.' using errcode='22023'; end if;
  if (select count(*) from jsonb_array_elements(p_stages) e where e->>'type'='WON' and e->'active'='true'::jsonb)<>1
    or (select count(*) from jsonb_array_elements(p_stages) e where e->>'type'='LOST' and e->'active'='true'::jsonb)<>1 then raise exception 'Mantenha exatamente uma etapa WON e uma LOST ativas.' using errcode='23514'; end if;
  select id into pipeline from public.pipelines where workspace_id=p_workspace_id and is_default;
  for item in select value from jsonb_array_elements(p_stages) loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'name') is distinct from 'string' or length(btrim(item->>'name')) not between 2 and 80 or item->>'name' ~ '[[:cntrl:]]'
      or item->>'name' !~ '[^[:space:]]' or jsonb_typeof(item->'color') is distinct from 'string' or item->>'color' !~ '^#[0-9a-fA-F]{6}$'
      or item->>'type' is null or item->>'type' not in ('NORMAL','WON','LOST') or jsonb_typeof(item->'active') is distinct from 'boolean' then raise exception 'Etapa inválida.' using errcode='22023'; end if;
    target:=case when nullif(item->>'id','') is null then gen_random_uuid() else (item->>'id')::uuid end;
    if target=any(ids) then raise exception 'Etapas duplicadas.' using errcode='22023'; end if;
    ids:=array_append(ids,target);
    select * into previous from public.pipeline_stages where workspace_id=p_workspace_id and pipeline_id=pipeline and id=target;
    if nullif(item->>'id','') is not null and previous.id is null then raise exception 'Etapa não pertence a esta empresa.' using errcode='42501'; end if;
    if previous.id is not null and previous.type<>item->>'type' and exists(select 1 from public.leads where workspace_id=p_workspace_id and stage_id=target) then raise exception 'Mova os leads antes de alterar o tipo da etapa.' using errcode='23514'; end if;
    insert into public.pipeline_stages(id,workspace_id,pipeline_id,name,position,color,type,active,legacy_status)
      values(target,p_workspace_id,pipeline,btrim(item->>'name'),position,item->>'color',item->>'type',(item->>'active')::boolean,
        case item->>'type' when 'WON' then 'Fechado' when 'LOST' then 'Perdido' else coalesce(previous.legacy_status,'Qualificado') end)
      on conflict(id) do update set name=excluded.name,position=excluded.position,color=excluded.color,type=excluded.type,active=excluded.active,
        legacy_status=case excluded.type when 'WON' then 'Fechado' when 'LOST' then 'Perdido' else case when public.pipeline_stages.legacy_status in ('Fechado','Perdido') then 'Qualificado' else public.pipeline_stages.legacy_status end end;
    position:=position+1;
  end loop;
  if exists(select 1 from public.leads l join public.pipeline_stages s on s.id=l.stage_id and s.workspace_id=l.workspace_id where s.workspace_id=p_workspace_id and s.pipeline_id=pipeline and not (s.id=any(ids))) then raise exception 'Uma etapa com leads não pode ser excluída. Desative-a ou mova os leads.' using errcode='23514'; end if;
  delete from public.pipeline_stages where workspace_id=p_workspace_id and pipeline_id=pipeline and not (id=any(ids));
  -- Only derived stage labels change; normal lead auditing remains enabled at runtime.
  update public.leads l set data=l.data || jsonb_build_object('stageName',s.name,'stageType',s.type)
    from public.pipeline_stages s where l.workspace_id=p_workspace_id and s.workspace_id=l.workspace_id and s.id=l.stage_id
      and (l.data->>'stageName' is distinct from s.name or l.data->>'stageType' is distinct from s.type);
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'pipeline.configured');
  return public.list_pipeline_stages(p_workspace_id);
exception when invalid_text_representation then raise exception 'ID de etapa inválido.' using errcode='22023';
end; $$;

create function public.list_call_reviews(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or private.workspace_role(p_workspace_id) is null or not private.workspace_available(p_workspace_id) then raise exception 'Calls não autorizadas.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('lead_id',r.lead_id,'feedback',r.feedback,'score',r.score,'reviewed_by',r.reviewed_by,
    'reviewer_name',coalesce(nullif(p.display_name,''),p.email,'Usuário removido'),'reviewed_at',r.reviewed_at) order by r.reviewed_at desc),'[]') into result
    from public.call_reviews r join public.leads l on l.workspace_id=r.workspace_id and l.id=r.lead_id left join public.profiles p on p.id=r.reviewed_by
    where r.workspace_id=p_workspace_id and private.can_read_lead(l.workspace_id,l.owner_id);
  return result;
end; $$;
create function public.review_call(p_workspace_id uuid,p_lead_id text,p_feedback text,p_score integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb;
begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if auth.uid() is null or private.workspace_role(p_workspace_id) not in ('admin','manager') or private.workspace_role(p_workspace_id) is null then raise exception 'Somente admin e manager revisam calls.' using errcode='42501'; end if;
  perform private.assert_available(p_workspace_id);
  if p_feedback is null or length(btrim(p_feedback)) not between 1 and 10000 or p_score is null or p_score not between 0 and 10 then raise exception 'Informe feedback e nota de 0 a 10.' using errcode='22023'; end if;
  perform 1 from public.leads where workspace_id=p_workspace_id and id=p_lead_id for update;
  if not found then raise exception 'Call não encontrada nesta empresa.' using errcode='P0002'; end if;
  insert into public.call_reviews(workspace_id,lead_id,feedback,score,reviewed_by,reviewed_at)
    values(p_workspace_id,p_lead_id,btrim(p_feedback),p_score,auth.uid(),now())
    on conflict(workspace_id,lead_id) do update set feedback=excluded.feedback,score=excluded.score,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at;
  select item into result from jsonb_array_elements(public.list_call_reviews(p_workspace_id)) item where item->>'lead_id'=p_lead_id;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'call.reviewed',jsonb_build_object('lead_id',p_lead_id));
  return result;
end; $$;

create function private.resolve_import_stage(p_workspace_id uuid,p_data jsonb) returns uuid
language plpgsql stable security definer set search_path = ''
as $$ declare result uuid; preferred_type text;
begin
  -- A valid local FK is authoritative. Foreign/inactive IDs are mapped by business kind.
  if coalesce(p_data->>'stageId','') ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
    select id into result from public.pipeline_stages where workspace_id=p_workspace_id and id=(p_data->>'stageId')::uuid and active;
  end if;
  if result is not null then return result; end if;
  preferred_type:=case when p_data->>'stageType' in ('NORMAL','WON','LOST') then p_data->>'stageType'
    when p_data->>'status'='Fechado' then 'WON' when p_data->>'status'='Perdido' then 'LOST' else 'NORMAL' end;
  -- Editable names can collide between stages of different types. Never downgrade a win/loss
  -- or upgrade an ordinary lead merely because another company's label matches.
  if nullif(p_data->>'stageName','') is not null then
    select id into result from public.pipeline_stages where workspace_id=p_workspace_id and name=p_data->>'stageName'
      and type=preferred_type and active order by position limit 1;
  end if;
  if result is null then
    select id into result from public.pipeline_stages where workspace_id=p_workspace_id and type=preferred_type and active
      order by (legacy_status=p_data->>'status') desc,position limit 1;
  end if;
  return result;
end; $$;

create or replace function public.import_leads(p_workspace_id uuid, p_leads jsonb, p_owner_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare assigned_owner uuid := coalesce(p_owner_id,auth.uid()); item jsonb; imported integer := 0; input_count integer; affected integer;
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
  for item in select value from jsonb_array_elements(p_leads) loop
    insert into public.leads(workspace_id,id,owner_id,data,stage_id,loss_reason_grandfathered) values(p_workspace_id,item ->> 'id',assigned_owner,item,private.resolve_import_stage(p_workspace_id,item),(item->>'status'='Perdido' and nullif(item->>'lossReason','') is null)) on conflict(workspace_id,id) do nothing;
    get diagnostics affected = row_count;
    imported := imported + affected;
  end loop;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'leads.imported',jsonb_build_object('imported',imported,'skipped',input_count - imported));
  return jsonb_build_object('imported',imported,'skipped',input_count - imported);
end; $$;


create or replace function public.export_workspace(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb;
begin
  -- Portability remains available to the client's administrator after billing expires.
  if auth.uid() is null or private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Somente o administrador da empresa exporta o workspace.' using errcode = '42501'; end if;
  select jsonb_build_object('version',1,'exported_at',now(),'workspace_id',p_workspace_id,
    'leads',coalesce((select jsonb_agg(data order by created_at) from public.leads where workspace_id = p_workspace_id),'[]'),
    'pipelines',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'is_default',is_default,'created_at',created_at)) from public.pipelines where workspace_id=p_workspace_id),'[]'),
    'pipeline_stages',coalesce((select jsonb_agg(jsonb_build_object('id',id,'pipeline_id',pipeline_id,'name',name,'position',position,'color',color,'type',type,'active',active) order by position) from public.pipeline_stages where workspace_id=p_workspace_id),'[]'),
    'call_reviews',coalesce((select jsonb_agg(jsonb_build_object('lead_id',lead_id,'feedback',feedback,'score',score,'reviewed_by',reviewed_by,'reviewed_at',reviewed_at)) from public.call_reviews where workspace_id=p_workspace_id),'[]'),
    'settings',jsonb_build_object('name',s.name,'commissionRate',s.commission_rate,'revenueGoal',s.revenue_goal),
    'privacy',jsonb_build_object('retention_days',w.retention_days,'privacy_contact_email',w.privacy_contact_email),
    'lead_privacy',coalesce((select jsonb_agg(jsonb_build_object('id',id,'owner_id',owner_id,'lawful_basis',lawful_basis,'consent_at',consent_at,'retention_until',retention_until)) from public.leads where workspace_id = p_workspace_id),'[]')) into result
    from public.workspaces w join public.workspace_settings s on s.workspace_id = w.id where w.id = p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.exported');
  return result;
end; $$;


revoke all on public.pipelines,public.pipeline_stages,public.call_reviews from public,anon,authenticated;
grant select on public.pipelines,public.pipeline_stages,public.call_reviews to authenticated;
grant all on public.pipelines,public.pipeline_stages,public.call_reviews to service_role;
grant insert(stage_id),update(stage_id) on public.leads to authenticated;
revoke all on function private.create_default_pipeline(),private.valid_recording_url(text),private.valid_legacy_lead_data(jsonb),private.resolve_import_stage(uuid,jsonb) from public,anon,authenticated;
grant execute on function private.valid_recording_url(text),private.valid_legacy_lead_data(jsonb) to authenticated;
grant execute on function private.create_default_pipeline(),private.valid_recording_url(text),private.valid_legacy_lead_data(jsonb),private.resolve_import_stage(uuid,jsonb) to service_role;
revoke all on function public.list_pipeline_stages(uuid),public.save_pipeline_stages(uuid,jsonb),public.list_call_reviews(uuid),public.review_call(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.list_pipeline_stages(uuid),public.save_pipeline_stages(uuid,jsonb),public.list_call_reviews(uuid),public.review_call(uuid,text,text,integer) to authenticated,service_role;

comment on table public.pipeline_stages is 'Tenant-scoped stages. Terminal behavior depends on type, never its editable name. Inactive stages keep existing leads readable.';
comment on column public.leads.loss_reason_grandfathered is 'Service-only compatibility marker for migrated/imported historical LOST leads. A new transition into LOST always requires a reason.';
comment on table public.call_reviews is 'Leadership feedback kept separately from seller JSON. Only review_call writes reviewer identity and timestamp.';
notify pgrst, 'reload schema';
commit;
