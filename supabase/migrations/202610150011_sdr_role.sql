-- HIGH CLOSER: SDR is an own-opportunity operational role, equivalent to Closer.
-- Installed migrations 001–010 remain immutable. No existing role or lead is changed.
begin;

alter table public.memberships drop constraint memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check(role in ('admin','manager','closer','sdr','viewer'));
alter table public.invitations drop constraint invitations_role_check;
alter table public.invitations add constraint invitations_role_check
  check(role in ('admin','manager','closer','sdr','viewer'));

-- Existing RLS policies call these helpers. No platform-admin bypass is added.
create or replace function private.can_read_lead(p_workspace_id uuid, p_owner_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.workspace_available(p_workspace_id) and
    (private.workspace_role(p_workspace_id) in ('admin', 'manager', 'viewer')
      or (private.workspace_role(p_workspace_id) in ('closer','sdr') and p_owner_id = auth.uid()));
$$;

create or replace function private.can_write_lead(p_workspace_id uuid, p_owner_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.workspace_available(p_workspace_id) and
    (private.workspace_role(p_workspace_id) in ('admin', 'manager')
      or (private.workspace_role(p_workspace_id) in ('closer','sdr') and p_owner_id = auth.uid()));
$$;

create or replace function private.assignable_owner(p_workspace_id uuid, p_owner_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.memberships where workspace_id = p_workspace_id and user_id = p_owner_id and is_active and role in ('admin', 'manager', 'closer', 'sdr')); $$;

create or replace function public.update_member(p_workspace_id uuid, p_user_id uuid, p_role text, p_is_active boolean) returns void
language plpgsql security definer set search_path = ''
as $$ declare previous public.memberships%rowtype; max_seats integer;
begin
  perform private.assert_manage(p_workspace_id);
  if p_role is null or p_role not in ('admin','manager','closer','sdr','viewer') or p_is_active is null then raise exception 'Papel ou estado inválido.' using errcode = '22023'; end if;
  select * into previous from public.memberships where workspace_id = p_workspace_id and user_id = p_user_id;
  if previous.user_id is null then raise exception 'Membro não encontrado.' using errcode = 'P0002'; end if;
  if exists(select 1 from public.workspaces where id = p_workspace_id and owner_id = p_user_id) and (p_role <> 'admin' or not p_is_active) then raise exception 'Transfira a propriedade antes de desativar ou alterar o dono.' using errcode = '23514'; end if;
  if previous.is_active and previous.role = 'admin' and (not p_is_active or p_role <> 'admin') and not exists(select 1 from public.memberships where workspace_id = p_workspace_id and user_id <> p_user_id and is_active and role = 'admin') then raise exception 'Mantenha ao menos um administrador ativo.' using errcode = '23514'; end if;
  if p_is_active and not previous.is_active then
    perform private.assert_available(p_workspace_id);
    select seat_limit into max_seats from public.subscriptions where workspace_id = p_workspace_id;
    if private.reserved_seats(p_workspace_id) >= max_seats then raise exception 'Limite de acessos atingido.' using errcode = '23514'; end if;
  end if;
  update public.memberships set role = p_role, is_active = p_is_active, updated_at = now() where workspace_id = p_workspace_id and user_id = p_user_id;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'membership.updated',jsonb_build_object('user_id',p_user_id,'role',p_role,'is_active',p_is_active));
end; $$;

create or replace function public.invite_member(p_workspace_id uuid, p_email text, p_role text default 'closer', p_name text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare normalized_email text := lower(btrim(p_email)); normalized_name text := case when p_name is null then null else btrim(p_name) end; invitation public.invitations%rowtype; raw_token text; max_seats integer;
begin
  perform private.assert_manage(p_workspace_id);
  perform private.assert_available(p_workspace_id);
  if p_role is null or p_role not in ('admin','manager','closer','sdr','viewer') or normalized_email is null or length(normalized_email) > 320 or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'E-mail ou papel inválido.' using errcode = '22023'; end if;
  if normalized_name is not null and (length(normalized_name) not between 2 and 120 or normalized_name !~ '[^[:space:]]' or normalized_name ~ '[[:cntrl:]]') then raise exception 'Informe um nome de 2 a 120 caracteres.' using errcode = '22023'; end if;
  if exists(select 1 from public.workspaces where id = p_workspace_id and owner_id is null) and p_role <> 'admin' then raise exception 'Convide primeiro o administrador da empresa.' using errcode = '22023'; end if;
  if exists(select 1 from public.memberships m join public.profiles p on p.id = m.user_id where m.workspace_id = p_workspace_id and m.is_active and lower(p.email) = normalized_email) then raise exception 'Essa pessoa já participa do workspace.' using errcode = '23505'; end if;
  -- Reissuing invalidates the previous token and releases its seat reservation.
  update public.invitations set revoked_at = now() where workspace_id = p_workspace_id and email = normalized_email and accepted_at is null and revoked_at is null;
  select seat_limit into max_seats from public.subscriptions where workspace_id = p_workspace_id;
  if private.reserved_seats(p_workspace_id) >= max_seats then raise exception 'Limite de acessos atingido. Revogue um convite ou ajuste o plano.' using errcode = '23514'; end if;
  raw_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.invitations(workspace_id,email,role,token_hash,invited_by,display_name)
    values(p_workspace_id,normalized_email,p_role,encode(extensions.digest(raw_token,'sha256'),'hex'),auth.uid(),normalized_name) returning * into invitation;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'invitation.created',jsonb_build_object('invitation_id',invitation.id,'role',p_role));
  return jsonb_build_object('id',invitation.id,'name',invitation.display_name,'email',invitation.email,'role',invitation.role,'token',raw_token,'expires_at',invitation.expires_at);
end; $$;

create or replace function public.save_activity(p_workspace_id uuid,p_lead_id text,p_title text,p_type text,p_due_at timestamptz,
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
    if private.workspace_role(p_workspace_id) in ('closer','sdr') and assignee<>auth.uid() then
      raise exception 'Closer e SDR só atribuem novas atividades a si mesmos.' using errcode='42501'; end if;
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

create or replace function public.platform_inbound_options(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.assert_platform_workspace(p_workspace_id);
  return jsonb_build_object(
    'stages',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.position)
      from public.pipeline_stages s join public.pipelines p on p.workspace_id=s.workspace_id and p.id=s.pipeline_id
      where s.workspace_id=p_workspace_id and p.is_default and s.active and s.type='NORMAL'),'[]'),
    'owners',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',private.effective_member_name(p_workspace_id,m.user_id)) order by m.created_at)
      from public.memberships m where m.workspace_id=p_workspace_id and m.is_active and m.role in ('admin','manager','closer','sdr')),'[]')
  );
end; $$;

create or replace function public.platform_list_administrative_audit(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  perform private.assert_platform_workspace(p_workspace_id);
  -- Exact action allowlist; project typed allowlisted keys rather than trusting old
  -- free-form JSON. Commercial actions and their identifiers are never returned.
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'actor_id',l.actor_id,'action',l.action,'created_at',l.created_at,
    'details',jsonb_strip_nulls(case
      when l.action in ('invitation.created','invitation.accepted') then jsonb_build_object('invitation_id',case when jsonb_typeof(l.details->'invitation_id')='string' and l.details->>'invitation_id' ~ '^[a-f0-9-]{36}$' then l.details->>'invitation_id' end,
        'role',case when l.details->>'role' in ('admin','manager','closer','sdr','viewer') then l.details->>'role' end)
      when l.action='invitation.revoked' then jsonb_build_object('invitation_id',case when jsonb_typeof(l.details->'invitation_id')='string' and l.details->>'invitation_id' ~ '^[a-f0-9-]{36}$' then l.details->>'invitation_id' end)
      when l.action='membership.updated' then jsonb_build_object('user_id',case when jsonb_typeof(l.details->'user_id')='string' and l.details->>'user_id' ~ '^[a-f0-9-]{36}$' then l.details->>'user_id' end,
        'role',case when l.details->>'role' in ('admin','manager','closer','sdr','viewer') then l.details->>'role' end,
        'is_active',case when jsonb_typeof(l.details->'is_active')='boolean' then l.details->'is_active' end)
      when l.action='membership.display_name_updated' then jsonb_build_object('user_id',case when jsonb_typeof(l.details->'user_id')='string' and l.details->>'user_id' ~ '^[a-f0-9-]{36}$' then l.details->>'user_id' end)
      when l.action='subscription.updated' then jsonb_build_object('plan',case when l.details->>'plan' in ('individual','team') then l.details->>'plan' end,
        'status',case when l.details->>'status' in ('trial','active','past_due','cancelled','suspended','expired') then l.details->>'status' end,
        'seat_limit',case when jsonb_typeof(l.details->'seat_limit')='number' and l.details->>'seat_limit' ~ '^[0-9]{1,5}$' then l.details->'seat_limit' end)
      when l.action in ('integration.created','integration.updated','integration.status_updated','integration.token_rotated','integration.archived') then jsonb_build_object('integration_id',case when jsonb_typeof(l.details->'integration_id')='string' and l.details->>'integration_id' ~ '^[a-f0-9-]{36}$' then l.details->>'integration_id' end,
        'active',case when jsonb_typeof(l.details->'active')='boolean' then l.details->'active' end)
      else '{}'::jsonb end)) order by l.created_at desc,l.id desc),'[]') into result
    from (select id,actor_id,action,created_at,details from public.audit_logs where workspace_id=p_workspace_id and action in (
      'workspace.created','workspace.self_service_created','workspace.renamed','workspace.institutional_updated','workspace.owner_transferred',
      'membership.updated','membership.display_name_updated','invitation.created','invitation.accepted','invitation.revoked','subscription.updated',
      'integration.created','integration.updated','integration.status_updated','integration.token_rotated','integration.archived')
      order by created_at desc,id desc limit 200) l;
  return result;
end; $$;

-- CREATE OR REPLACE preserves existing grants. Repeat the exact privilege boundary
-- explicitly: policy helpers are authenticated; operational/administrative RPCs
-- remain authenticated with their current server-side membership checks.
revoke all on function private.can_read_lead(uuid,uuid), private.can_write_lead(uuid,uuid), private.assignable_owner(uuid,uuid)
  from public,anon,authenticated;
grant execute on function private.can_read_lead(uuid,uuid), private.can_write_lead(uuid,uuid), private.assignable_owner(uuid,uuid)
  to authenticated,service_role;
revoke all on function public.invite_member(uuid,text,text,text),public.update_member(uuid,uuid,text,boolean),
  public.save_activity(uuid,text,text,text,timestamptz,uuid,text,uuid),public.platform_inbound_options(uuid),
  public.platform_list_administrative_audit(uuid) from public,anon,authenticated;
grant execute on function public.invite_member(uuid,text,text,text),public.update_member(uuid,uuid,text,boolean),
  public.save_activity(uuid,text,text,text,timestamptz,uuid,text,uuid),public.platform_inbound_options(uuid),
  public.platform_list_administrative_audit(uuid) to authenticated,service_role;

comment on function private.can_read_lead(uuid,uuid) is 'Active members only: Admin/Manager/Viewer read their workspace; Closer/SDR read only assigned opportunities. Master is never a commercial override.';
comment on function private.can_write_lead(uuid,uuid) is 'Active members only: Admin/Manager write their workspace; Closer/SDR write only assigned opportunities.';
notify pgrst, 'reload schema';
commit;
