-- Lead 360: tenant-scoped activities and immutable, automatically recorded commercial history.
-- Installed migrations and existing lead/call payloads remain unchanged.
begin;

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null,
  assigned_to uuid not null,
  created_by uuid references public.profiles(id) on delete set null,
  type text not null check(type in ('follow_up','call','whatsapp','email','meeting','other')),
  title text not null check(length(btrim(title)) between 1 and 180 and title=btrim(title) and title !~ '[[:cntrl:]]'),
  description text not null default '' check(length(description)<=4000),
  due_at timestamptz not null check(isfinite(due_at)),
  status text not null default 'pending' check(status in ('pending','completed','cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_id,lead_id) references public.leads(workspace_id,id) on delete cascade,
  foreign key(workspace_id,assigned_to) references public.memberships(workspace_id,user_id) on delete restrict,
  check((status='completed')=(completed_at is not null))
);
create index activities_lead_due_idx on public.activities(workspace_id,lead_id,due_at,id);
create index activities_workspace_due_idx on public.activities(workspace_id,due_at,id);
create index activities_pending_due_idx on public.activities(workspace_id,due_at,lead_id) where status='pending';

create table public.lead_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null check(event_type in ('lead.created','lead.owner_changed','lead.stage_changed','lead.ticket_changed',
    'call.scheduled','call.recorded','call.updated','call.recording_added','call.reviewed','call.snapshot',
    'activity.created','activity.updated','activity.completed','activity.cancelled',
    'lead.won','lead.lost','lead.reopened','lead.loss_reason_changed')),
  metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_id,lead_id) references public.leads(workspace_id,id) on delete cascade
);
create index lead_events_lead_cursor_idx on public.lead_events(workspace_id,lead_id,id desc);
create index lead_events_calls_idx on public.lead_events(workspace_id,lead_id,id desc) where metadata ? 'call';

create function private.effective_member_name(p_workspace_id uuid,p_user_id uuid) returns text
language sql stable security definer set search_path = ''
as $$ select coalesce(m.display_name,nullif(p.display_name,''),'Membro da equipe')
  from public.profiles p left join public.memberships m on m.workspace_id=p_workspace_id and m.user_id=p.id where p.id=p_user_id; $$;

create function private.lead_call_snapshot(p_data jsonb) returns jsonb
language sql immutable set search_path = '' set timezone = 'UTC'
as $$ select case when coalesce(p_data->>'callDate','')='' and p_data->>'attendance'='Pendente' and p_data->'callScore'='null'::jsonb then null else
  jsonb_build_object('callDate',case when coalesce(p_data->>'callDate','')='' then null else (p_data->>'callDate')::timestamptz end,
    'attendance',p_data->'attendance','callScore',p_data->'callScore','callSummary',p_data->'callSummary','objection',p_data->'objection',
    'pain',p_data->'pain','urgency',p_data->'urgency','financialCapacity',p_data->'financialCapacity','decisionMaker',p_data->'decisionMaker',
    'closerError',p_data->'closerError','recordingUrl',coalesce(p_data->>'recordingUrl',''),'nextStep',coalesce(p_data->>'nextStep','')) end; $$;

create function private.add_lead_event(p_workspace_id uuid,p_lead_id text,p_event_type text,p_metadata jsonb default '{}') returns void
language sql security definer set search_path = ''
as $$ insert into public.lead_events(workspace_id,lead_id,actor_id,event_type,metadata,created_at)
  values(p_workspace_id,p_lead_id,auth.uid(),p_event_type,p_metadata,clock_timestamp()); $$;

create function private.assert_read_lead(p_workspace_id uuid,p_lead_id text) returns void
language plpgsql stable security definer set search_path = ''
as $$ begin
  if auth.uid() is null or not exists(select 1 from public.leads where workspace_id=p_workspace_id and id=p_lead_id
    and private.can_read_lead(workspace_id,owner_id)) then raise exception 'Oportunidade não autorizada.' using errcode='42501'; end if;
end; $$;

create function private.lock_writable_lead(p_workspace_id uuid,p_lead_id text) returns public.leads
language plpgsql security definer set search_path = ''
as $$ declare result public.leads;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária.' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  select * into result from public.leads where workspace_id=p_workspace_id and id=p_lead_id for update;
  if not found or not coalesce(private.can_write_lead(p_workspace_id,result.owner_id),false) then
    raise exception 'Oportunidade não autorizada para edição.' using errcode='42501'; end if;
  return result;
end; $$;

create function private.activity_json(p_activity public.activities) returns jsonb
language sql stable security definer set search_path = ''
as $$ select to_jsonb(p_activity)||jsonb_build_object('assigned_name',coalesce(private.effective_member_name(p_activity.workspace_id,p_activity.assigned_to),'Usuário removido'),
  'created_by_name',coalesce(private.effective_member_name(p_activity.workspace_id,p_activity.created_by),'Usuário removido')); $$;

create function private.prepare_activity() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  if tg_op='INSERT' then
    new.created_by:=auth.uid(); new.created_at:=clock_timestamp();
  else
    if new.id<>old.id or new.workspace_id<>old.workspace_id or new.lead_id<>old.lead_id then
      raise exception 'Não é possível mover uma atividade para outra oportunidade.' using errcode='42501'; end if;
    new.created_by:=old.created_by; new.created_at:=old.created_at;
  end if;
  if new.status='completed' then
    if tg_op='UPDATE' and old.status='completed' then new.completed_at:=old.completed_at;
    else new.completed_at:=clock_timestamp(); end if;
  else new.completed_at:=null; end if;
  new.updated_at:=clock_timestamp();
  return new;
end; $$;
create trigger activity_prepare before insert or update on public.activities for each row execute function private.prepare_activity();

create function public.save_activity(p_workspace_id uuid,p_lead_id text,p_title text,p_type text,p_due_at timestamptz,
  p_assigned_to uuid default null,p_description text default '',p_activity_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare lead public.leads; previous public.activities; result public.activities; assignee uuid;
begin
  lead:=private.lock_writable_lead(p_workspace_id,p_lead_id);
  if p_title is null or length(btrim(p_title)) not between 1 and 180 or p_title ~ '[[:cntrl:]]' or p_title !~ '[^[:space:]]'
    or p_type is null or p_type not in ('follow_up','call','whatsapp','email','meeting','other')
    or p_due_at is null or not isfinite(p_due_at) or length(coalesce(p_description,''))>4000 then
    raise exception 'Informe título, tipo e data válidos para a atividade.' using errcode='22023'; end if;
  if p_activity_id is not null then
    select * into previous from public.activities where id=p_activity_id and workspace_id=p_workspace_id and lead_id=p_lead_id for update;
    if not found then raise exception 'Atividade não encontrada nesta oportunidade.' using errcode='P0002'; end if;
    if previous.status<>'pending' then raise exception 'Atividades finalizadas não podem ser editadas.' using errcode='23514'; end if;
  end if;
  assignee:=coalesce(p_assigned_to,previous.assigned_to,lead.owner_id);
  if previous.id is null or assignee is distinct from previous.assigned_to then
    if private.workspace_role(p_workspace_id)='closer' and assignee<>auth.uid() then
      raise exception 'O closer só atribui novas atividades a si mesmo.' using errcode='42501'; end if;
    if not private.assignable_owner(p_workspace_id,assignee) then raise exception 'Responsável precisa ser um membro ativo com edição.' using errcode='23514'; end if;
  end if;
  if previous.id is null then
    insert into public.activities(workspace_id,lead_id,assigned_to,type,title,description,due_at)
      values(p_workspace_id,p_lead_id,assignee,p_type,btrim(p_title),coalesce(p_description,''),p_due_at) returning * into result;
  else
    update public.activities set assigned_to=assignee,type=p_type,title=btrim(p_title),description=coalesce(p_description,''),due_at=p_due_at
      where id=previous.id returning * into result;
  end if;
  return private.activity_json(result);
end; $$;

create function public.set_activity_status(p_workspace_id uuid,p_activity_id uuid,p_status text) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare previous public.activities; result public.activities;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária.' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if private.workspace_role(p_workspace_id) is null or not private.workspace_available(p_workspace_id) then
    raise exception 'Atividades não autorizadas.' using errcode='42501'; end if;
  select * into previous from public.activities where workspace_id=p_workspace_id and id=p_activity_id;
  if not found then raise exception 'Atividade não encontrada nesta empresa.' using errcode='P0002'; end if;
  perform private.lock_writable_lead(p_workspace_id,previous.lead_id);
  if p_status is null or p_status not in ('completed','cancelled') then raise exception 'Status de atividade inválido.' using errcode='22023'; end if;
  select * into previous from public.activities where workspace_id=p_workspace_id and id=p_activity_id for update;
  if previous.status=p_status then return private.activity_json(previous); end if;
  if previous.status<>'pending' then raise exception 'Atividade já finalizada.' using errcode='23514'; end if;
  update public.activities set status=p_status where workspace_id=p_workspace_id and id=p_activity_id returning * into result;
  return private.activity_json(result);
end; $$;

create function private.capture_activity_events() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare event text; details jsonb;
begin
  details:=jsonb_build_object('activity_id',new.id,'title',new.title,'type',new.type,'due_at',new.due_at,'assigned_to',new.assigned_to,'status',new.status,'completed_at',new.completed_at);
  if tg_op='INSERT' then event:='activity.created';
  elsif new.status is distinct from old.status then
    event:=case new.status when 'completed' then 'activity.completed' else 'activity.cancelled' end;
  elsif row(new.assigned_to,new.type,new.title,new.description,new.due_at) is distinct from row(old.assigned_to,old.type,old.title,old.description,old.due_at) then event:='activity.updated';
  else return null; end if;
  perform private.add_lead_event(new.workspace_id,new.lead_id,event,details);
  return null;
end; $$;
create trigger activity_history after insert or update on public.activities for each row execute function private.capture_activity_events();

create function private.capture_lead_events() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare old_call jsonb; new_call jsonb:=private.lead_call_snapshot(new.data); old_type text;
begin
  if tg_op='INSERT' then
    perform private.add_lead_event(new.workspace_id,new.id,'lead.created',jsonb_build_object('owner_id',new.owner_id,'stage_id',new.stage_id,'stage_name',new.data->>'stageName','stage_type',new.data->>'stageType','ticket',new.data->'ticket'));
  else
    old_call:=private.lead_call_snapshot(old.data); old_type:=old.data->>'stageType';
    if new.owner_id is distinct from old.owner_id then
      perform private.add_lead_event(new.workspace_id,new.id,'lead.owner_changed',jsonb_build_object('from_owner_id',old.owner_id,'to_owner_id',new.owner_id)); end if;
    if new.stage_id is distinct from old.stage_id then
      perform private.add_lead_event(new.workspace_id,new.id,'lead.stage_changed',jsonb_build_object('from_stage_id',old.stage_id,'from_stage_name',old.data->>'stageName','from_stage_type',old_type,'to_stage_id',new.stage_id,'to_stage_name',new.data->>'stageName','to_stage_type',new.data->>'stageType')); end if;
    if new.data->'ticket' is distinct from old.data->'ticket' then
      perform private.add_lead_event(new.workspace_id,new.id,'lead.ticket_changed',jsonb_build_object('previous_ticket',old.data->'ticket','ticket',new.data->'ticket')); end if;
    if old_type in ('WON','LOST') and new.data->>'stageType'='NORMAL' then
      perform private.add_lead_event(new.workspace_id,new.id,'lead.reopened',jsonb_build_object('from_type',old_type,'stage_name',new.data->>'stageName')); end if;
  end if;
  if new.data->>'stageType'='WON' and old_type is distinct from 'WON' then
    perform private.add_lead_event(new.workspace_id,new.id,'lead.won',jsonb_build_object('closed_value',new.data->'closedValue','stage_name',new.data->>'stageName')); end if;
  if new.data->>'stageType'='LOST' and old_type is distinct from 'LOST' then
    perform private.add_lead_event(new.workspace_id,new.id,'lead.lost',jsonb_build_object('loss_reason',coalesce(new.data->>'lossReason',''),'loss_comment',coalesce(new.data->>'lossComment',''),'stage_name',new.data->>'stageName'));
  elsif tg_op='UPDATE' and new.data->>'stageType'='LOST' and row(new.data->'lossReason',new.data->'lossComment') is distinct from row(old.data->'lossReason',old.data->'lossComment') then
    perform private.add_lead_event(new.workspace_id,new.id,'lead.loss_reason_changed',jsonb_build_object('loss_reason',coalesce(new.data->>'lossReason',''),'loss_comment',coalesce(new.data->>'lossComment',''))); end if;
  if new_call is not null and new_call is distinct from old_call then
    if old_call is null or new_call->'callDate' is distinct from old_call->'callDate' then
      perform private.add_lead_event(new.workspace_id,new.id,case when new.data->>'attendance'='Pendente' then 'call.scheduled' else 'call.recorded' end,
        jsonb_build_object('call',new_call,'call_score',new.data->'callScore','attendance',new.data->>'attendance'));
    elsif old.data->>'attendance'='Pendente' and new.data->>'attendance'<>'Pendente' then
      perform private.add_lead_event(new.workspace_id,new.id,'call.recorded',jsonb_build_object('call',new_call,'call_score',new.data->'callScore','attendance',new.data->>'attendance'));
    else perform private.add_lead_event(new.workspace_id,new.id,'call.updated',jsonb_build_object('call',new_call,'call_score',new.data->'callScore','attendance',new.data->>'attendance')); end if;
  end if;
  if coalesce(new.data->>'recordingUrl','')<>'' and (tg_op='INSERT' or new.data->'recordingUrl' is distinct from old.data->'recordingUrl') then
    perform private.add_lead_event(new.workspace_id,new.id,'call.recording_added',jsonb_build_object('recording_url',new.data->>'recordingUrl','call',new_call)); end if;
  return null;
end; $$;
create trigger lead_commercial_history after insert or update on public.leads for each row execute function private.capture_lead_events();

create function private.capture_call_review_event() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare lead public.leads; snapshot jsonb;
begin
  select * into lead from public.leads where workspace_id=new.workspace_id and id=new.lead_id;
  snapshot:=private.lead_call_snapshot(lead.data);
  perform private.add_lead_event(new.workspace_id,new.lead_id,'call.reviewed',jsonb_build_object('call',snapshot,
    'call_date',snapshot->'callDate','score',new.score,'review',jsonb_build_object('feedback',new.feedback,'score',new.score,'reviewed_by',new.reviewed_by,'reviewed_at',new.reviewed_at)));
  return null;
end; $$;
create trigger call_review_history after insert or update on public.call_reviews for each row execute function private.capture_call_review_event();

-- Backfill only facts that already exist in the database. The current legacy call is not
-- presented as a reconstructed complete history, and no old lead/call row is modified.
insert into public.lead_events(workspace_id,lead_id,actor_id,event_type,metadata,created_at)
  select workspace_id,id,created_by,'lead.created',jsonb_build_object('backfilled',true),created_at
  from public.leads order by created_at,workspace_id,id;
insert into public.lead_events(workspace_id,lead_id,actor_id,event_type,metadata,created_at)
  select l.workspace_id,l.id,null,'call.snapshot',jsonb_build_object('legacy',true,'call',private.lead_call_snapshot(l.data),'call_date',private.lead_call_snapshot(l.data)->'callDate',
    'review',case when r.lead_id is null then null else jsonb_build_object('feedback',r.feedback,'score',r.score,'reviewed_by',r.reviewed_by,'reviewed_at',r.reviewed_at) end),clock_timestamp()
  from public.leads l left join public.call_reviews r on r.workspace_id=l.workspace_id and r.lead_id=l.id where private.lead_call_snapshot(l.data) is not null;

alter table public.activities enable row level security;
alter table public.lead_events enable row level security;
create policy activities_read on public.activities for select to authenticated using(exists(select 1 from public.leads l where l.workspace_id=activities.workspace_id and l.id=activities.lead_id and private.can_read_lead(l.workspace_id,l.owner_id)));
create policy lead_events_read on public.lead_events for select to authenticated using(exists(select 1 from public.leads l where l.workspace_id=lead_events.workspace_id and l.id=lead_events.lead_id and private.can_read_lead(l.workspace_id,l.owner_id)));

create function public.list_lead_activities(p_workspace_id uuid,p_lead_id text default null,p_limit integer default 200,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare items jsonb; more boolean;
begin
  if auth.uid() is null or private.workspace_role(p_workspace_id) is null or not private.workspace_available(p_workspace_id) then raise exception 'Atividades não autorizadas.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset<0 then raise exception 'Paginação inválida.' using errcode='22023'; end if;
  if p_lead_id is not null then perform private.assert_read_lead(p_workspace_id,p_lead_id); end if;
  select coalesce(jsonb_agg(private.activity_json(a::public.activities) order by a.due_at,a.id),'[]') into items from
    (select a.* from public.activities a join public.leads l on l.workspace_id=a.workspace_id and l.id=a.lead_id
      where a.workspace_id=p_workspace_id and (p_lead_id is null or a.lead_id=p_lead_id) and (p_lead_id is not null or a.status='pending') and private.can_read_lead(l.workspace_id,l.owner_id)
      order by a.due_at,a.id limit p_limit offset p_offset) a;
  select exists(select 1 from public.activities a join public.leads l on l.workspace_id=a.workspace_id and l.id=a.lead_id
    where a.workspace_id=p_workspace_id and (p_lead_id is null or a.lead_id=p_lead_id) and (p_lead_id is not null or a.status='pending') and private.can_read_lead(l.workspace_id,l.owner_id)
    order by a.due_at,a.id offset (p_offset+p_limit) limit 1) into more;
  return jsonb_build_object('items',items,'next_offset',case when more then p_offset+p_limit else null end);
end; $$;

create function public.list_lead_events(p_workspace_id uuid,p_lead_id text,p_before_id bigint default null,p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare items jsonb; last_id bigint; more boolean;
begin
  perform private.assert_read_lead(p_workspace_id,p_lead_id);
  if p_limit is null or p_limit not between 1 and 100 or (p_before_id is not null and p_before_id<=0) then raise exception 'Paginação inválida.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'workspace_id',e.workspace_id,'lead_id',e.lead_id,'actor_id',e.actor_id,
    'actor_name',coalesce(private.effective_member_name(e.workspace_id,e.actor_id),'Usuário removido'),'event_type',e.event_type,'metadata',e.metadata||
      case when e.event_type='lead.owner_changed' then jsonb_build_object('from_owner_name',coalesce(private.effective_member_name(e.workspace_id,(e.metadata->>'from_owner_id')::uuid),'Usuário removido'),
        'to_owner_name',coalesce(private.effective_member_name(e.workspace_id,(e.metadata->>'to_owner_id')::uuid),'Usuário removido')) else '{}'::jsonb end,
    'created_at',e.created_at) order by e.id desc),'[]'),min(e.id) into items,last_id from
    (select * from public.lead_events where workspace_id=p_workspace_id and lead_id=p_lead_id and event_type<>'call.snapshot'
      and (p_before_id is null or id<p_before_id) order by id desc limit p_limit) e;
  select exists(select 1 from public.lead_events where workspace_id=p_workspace_id and lead_id=p_lead_id and event_type<>'call.snapshot' and id<last_id) into more;
  return jsonb_build_object('items',items,'next_cursor',case when more then last_id::text else null end);
end; $$;

create function public.list_lead_call_history(p_workspace_id uuid,p_lead_id text,p_limit integer default 20,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare items jsonb; total integer; lead public.leads; last_event_at timestamptz;
begin
  perform private.assert_read_lead(p_workspace_id,p_lead_id);
  select * into lead from public.leads where workspace_id=p_workspace_id and id=p_lead_id;
  select max(created_at) into last_event_at from public.lead_events where workspace_id=p_workspace_id and lead_id=p_lead_id and event_type<>'call.snapshot';
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 then raise exception 'Paginação inválida.' using errcode='22023'; end if;
  select count(distinct coalesce(metadata->'call'->>'callDate','undated')) into total from public.lead_events
    where workspace_id=p_workspace_id and lead_id=p_lead_id and jsonb_typeof(metadata->'call')='object';
  with latest as (
    select distinct on (coalesce(metadata->'call'->>'callDate','undated')) * from public.lead_events
      where workspace_id=p_workspace_id and lead_id=p_lead_id and jsonb_typeof(metadata->'call')='object'
      order by coalesce(metadata->'call'->>'callDate','undated'),id desc
  ), page as (select * from latest order by (metadata->'call'->>'callDate')::timestamptz desc nulls last,id desc limit p_limit offset p_offset)
  select coalesce(jsonb_agg(jsonb_build_object('id',coalesce(e.metadata->'call'->>'callDate','undated'),'call_date',e.metadata->'call'->'callDate','attendance',e.metadata->'call'->'attendance',
    'call_score',e.metadata->'call'->'callScore','call_summary',e.metadata->'call'->'callSummary','objection',e.metadata->'call'->'objection',
    'pain',e.metadata->'call'->'pain','urgency',e.metadata->'call'->'urgency','financial_capacity',e.metadata->'call'->'financialCapacity',
    'decision_maker',e.metadata->'call'->'decisionMaker','closer_error',e.metadata->'call'->'closerError','recording_url',e.metadata->'call'->'recordingUrl',
    'next_step',e.metadata->'call'->'nextStep','recorded_at',e.created_at,'legacy',coalesce((e.metadata->>'legacy')::boolean,false),
    'leadership_review',case when r.metadata->'review' is null then null else r.metadata->'review'||jsonb_build_object('reviewer_name',
      coalesce(private.effective_member_name(e.workspace_id,(r.metadata->'review'->>'reviewed_by')::uuid),'Usuário removido')) end)
    order by (e.metadata->'call'->>'callDate')::timestamptz desc nulls last,e.id desc),'[]') into items from page e
    left join lateral (select metadata from public.lead_events where workspace_id=p_workspace_id and lead_id=p_lead_id
      and jsonb_typeof(metadata->'review')='object' and jsonb_typeof(metadata->'call')='object' and coalesce(metadata->>'call_date','undated')=coalesce(e.metadata->'call'->>'callDate','undated')
      order by id desc limit 1) r on true;
  return jsonb_build_object('items',items,'next_offset',case when p_offset+p_limit<total then p_offset+p_limit else null end,'call_count',total,'owner_id',lead.owner_id,'owner_name',coalesce(private.effective_member_name(p_workspace_id,lead.owner_id),'Usuário removido'),'last_event_at',last_event_at);
end; $$;

create or replace function public.export_workspace(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Somente o administrador da empresa exporta o workspace.' using errcode='42501'; end if;
  select jsonb_build_object('version',1,'exported_at',now(),'workspace_id',p_workspace_id,
    'leads',coalesce((select jsonb_agg(data order by created_at) from public.leads where workspace_id=p_workspace_id),'[]'),
    'pipelines',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'is_default',is_default,'created_at',created_at)) from public.pipelines where workspace_id=p_workspace_id),'[]'),
    'pipeline_stages',coalesce((select jsonb_agg(jsonb_build_object('id',id,'pipeline_id',pipeline_id,'name',name,'position',position,'color',color,'type',type,'active',active) order by position) from public.pipeline_stages where workspace_id=p_workspace_id),'[]'),
    'call_reviews',coalesce((select jsonb_agg(jsonb_build_object('lead_id',lead_id,'feedback',feedback,'score',score,'reviewed_by',reviewed_by,'reviewed_at',reviewed_at)) from public.call_reviews where workspace_id=p_workspace_id),'[]'),
    'activities',coalesce((select jsonb_agg(to_jsonb(a) order by a.due_at,a.id) from public.activities a where workspace_id=p_workspace_id),'[]'),
    'lead_events',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('id',e.id::text) order by e.id) from public.lead_events e where workspace_id=p_workspace_id),'[]'),
    'settings',jsonb_build_object('name',s.name,'commissionRate',s.commission_rate,'revenueGoal',s.revenue_goal),
    'privacy',jsonb_build_object('retention_days',w.retention_days,'privacy_contact_email',w.privacy_contact_email),
    'lead_privacy',coalesce((select jsonb_agg(jsonb_build_object('id',id,'owner_id',owner_id,'lawful_basis',lawful_basis,'consent_at',consent_at,'retention_until',retention_until)) from public.leads where workspace_id=p_workspace_id),'[]')) into result
    from public.workspaces w join public.workspace_settings s on s.workspace_id=w.id where w.id=p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.exported');
  return result;
end; $$;

revoke all on public.activities,public.lead_events from public,anon,authenticated;
grant select on public.activities,public.lead_events to authenticated;
grant all on public.activities,public.lead_events to service_role;
grant usage,select on sequence public.lead_events_id_seq to service_role;
revoke all on function private.effective_member_name(uuid,uuid),private.lead_call_snapshot(jsonb),private.add_lead_event(uuid,text,text,jsonb),
  private.assert_read_lead(uuid,text),private.lock_writable_lead(uuid,text),private.activity_json(public.activities),private.prepare_activity(),
  private.capture_activity_events(),private.capture_lead_events(),private.capture_call_review_event() from public,anon,authenticated;
grant execute on function private.effective_member_name(uuid,uuid),private.lead_call_snapshot(jsonb),private.add_lead_event(uuid,text,text,jsonb),
  private.assert_read_lead(uuid,text),private.lock_writable_lead(uuid,text),private.activity_json(public.activities),private.prepare_activity(),
  private.capture_activity_events(),private.capture_lead_events(),private.capture_call_review_event() to service_role;
revoke all on function public.save_activity(uuid,text,text,text,timestamptz,uuid,text,uuid),public.set_activity_status(uuid,uuid,text),
  public.list_lead_activities(uuid,text,integer,integer),public.list_lead_events(uuid,text,bigint,integer),public.list_lead_call_history(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.save_activity(uuid,text,text,text,timestamptz,uuid,text,uuid),public.set_activity_status(uuid,uuid,text),
  public.list_lead_activities(uuid,text,integer,integer),public.list_lead_events(uuid,text,bigint,integer),public.list_lead_call_history(uuid,text,integer,integer) to authenticated,service_role;

comment on table public.activities is 'Tasks inherit the lead owner access policy; assigning a task never grants access to its lead. Clients write only through scoped RPCs.';
comment on table public.lead_events is 'Server-authored commercial history and versioned call snapshots, deleted with the lead for privacy/retention. Clients have read access only.';
comment on function public.list_lead_call_history(uuid,text,integer,integer) is 'Known call snapshots grouped by normalized date, with the review captured for that date. Legacy snapshots do not imply a reconstructed complete meeting history.';
notify pgrst,'reload schema';
commit;
