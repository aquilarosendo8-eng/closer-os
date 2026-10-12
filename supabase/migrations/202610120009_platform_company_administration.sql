-- HIGH CLOSER: explicit platform account administration, never commercial access.
-- Previously installed migrations are immutable. This migration is transactional.
begin;

alter table public.workspaces add column business_contact_email text not null default '';
alter table public.workspaces add constraint workspace_business_contact_email_valid check (
  business_contact_email = lower(btrim(business_contact_email)) and length(business_contact_email)<=254
  and business_contact_email !~ '[[:cntrl:]]'
  and business_contact_email !~ U&'[\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]'
  and (business_contact_email='' or business_contact_email ~ '^[^[:space:]@<>"\\]+@[^[:space:]@<>"\\]+\.[^[:space:]@<>"\\]+$')
);
comment on column public.workspaces.business_contact_email is 'Institutional commercial contact only. Independent of Auth email, administrator login and privacy contact.';

-- The receipt has no workspace/Auth FK: it must survive tenant deletion and account changes.
create table private.workspace_deletion_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique,
  workspace_name text not null,
  actor_id uuid not null,
  deleted_at timestamptz not null default clock_timestamp(),
  reason text not null check(length(btrim(reason)) between 10 and 500 and reason !~ '[[:cntrl:]]'),
  authorization_confirmed boolean not null check(authorization_confirmed),
  irreversible_confirmed boolean not null check(irreversible_confirmed)
);
alter table private.workspace_deletion_receipts enable row level security;
revoke all on private.workspace_deletion_receipts from public,anon,authenticated;
grant all on private.workspace_deletion_receipts to service_role;
comment on table private.workspace_deletion_receipts is 'Minimal platform deletion receipt, without leads, payloads, member contacts, recordings or credentials. No unreliable test-company classification is inferred.';

create function private.assert_platform_workspace(p_workspace_id uuid,p_lock boolean default false) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  if auth.uid() is null or not private.is_platform_admin() then
    raise exception 'Somente o administrador Master da plataforma pode executar esta operação.' using errcode='42501';
  end if;
  if p_lock then perform 1 from public.workspaces where id=p_workspace_id for update;
  else perform 1 from public.workspaces where id=p_workspace_id; end if;
  if not found then raise exception 'Empresa não encontrada.' using errcode='P0002'; end if;
  -- Recheck after the tenant lock, before any mutation.
  if not private.is_platform_admin() then raise exception 'Acesso Master revogado.' using errcode='42501'; end if;
end; $$;

create function public.platform_update_workspace_information(p_workspace_id uuid,p_name text,p_business_contact_email text) returns void
language plpgsql security definer set search_path = ''
as $$ declare normalized_name text; normalized_email text;
begin
  perform private.assert_platform_workspace(p_workspace_id,true);
  normalized_name:=private.checked_account_name(p_name,1);
  if normalized_name !~ U&'[^\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]' then
    raise exception 'Informe um nome de empresa válido.' using errcode='22023';
  end if;
  normalized_email:=lower(btrim(p_business_contact_email));
  if normalized_email is null or length(normalized_email)>254 or normalized_email ~ '[[:cntrl:]]'
    or normalized_email ~ U&'[\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]'
    or (normalized_email<>'' and normalized_email !~ '^[^[:space:]@<>"\\]+@[^[:space:]@<>"\\]+\.[^[:space:]@<>"\\]+$') then
    raise exception 'Informe um e-mail comercial válido ou deixe o campo vazio.' using errcode='22023';
  end if;
  update public.workspaces set name=normalized_name,business_contact_email=normalized_email where id=p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.institutional_updated');
end; $$;

create or replace function public.list_platform_workspaces() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or not private.is_platform_admin() then raise exception 'Acesso da plataforma não autorizado.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'business_contact_email',w.business_contact_email,
    'created_at',w.created_at,'owner_id',w.owner_id,'admin_email',p.email,
    'subscription',jsonb_build_object('plan',s.plan,'status',s.status,'seat_limit',s.seat_limit,'current_period_end',s.current_period_end,'trial_ends_at',s.trial_ends_at),
    'member_count',(select count(*) from public.memberships m where m.workspace_id=w.id and m.is_active)) order by w.created_at desc),'[]') into result
    from public.workspaces w join public.subscriptions s on s.workspace_id=w.id left join public.profiles p on p.id=w.owner_id;
  return result;
end; $$;

create function public.platform_inbound_options(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  perform private.assert_platform_workspace(p_workspace_id);
  return jsonb_build_object(
    'stages',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.position)
      from public.pipeline_stages s join public.pipelines p on p.workspace_id=s.workspace_id and p.id=s.pipeline_id
      where s.workspace_id=p_workspace_id and p.is_default and s.active and s.type='NORMAL'),'[]'),
    'owners',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',private.effective_member_name(p_workspace_id,m.user_id)) order by m.created_at)
      from public.memberships m where m.workspace_id=p_workspace_id and m.is_active and m.role in ('admin','manager','closer')),'[]')
  );
end; $$;

-- Remove pre-existing broad support reads. Necessary team metadata remains available
-- through list_members(), which validates a specific company and returns a narrow DTO.
create or replace function private.can_read_profile(p_user_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select p_user_id=auth.uid() or exists(
  select 1 from public.memberships me join public.memberships colleague using(workspace_id)
  where me.user_id=auth.uid() and me.is_active and colleague.user_id=p_user_id and colleague.is_active); $$;
drop policy settings_read on public.workspace_settings;
create policy settings_read on public.workspace_settings for select to authenticated using(private.workspace_role(workspace_id) is not null);
drop policy audit_read on public.audit_logs;
create policy audit_read on public.audit_logs for select to authenticated using(private.workspace_role(workspace_id)='admin');

create function public.platform_list_administrative_audit(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  perform private.assert_platform_workspace(p_workspace_id);
  -- Exact action allowlist; project typed allowlisted keys rather than trusting old
  -- free-form JSON. Commercial actions and their identifiers are never returned.
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'actor_id',l.actor_id,'action',l.action,'created_at',l.created_at,
    'details',jsonb_strip_nulls(case
      when l.action in ('invitation.created','invitation.accepted') then jsonb_build_object('invitation_id',case when jsonb_typeof(l.details->'invitation_id')='string' and l.details->>'invitation_id' ~ '^[a-f0-9-]{36}$' then l.details->>'invitation_id' end,
        'role',case when l.details->>'role' in ('admin','manager','closer','viewer') then l.details->>'role' end)
      when l.action='invitation.revoked' then jsonb_build_object('invitation_id',case when jsonb_typeof(l.details->'invitation_id')='string' and l.details->>'invitation_id' ~ '^[a-f0-9-]{36}$' then l.details->>'invitation_id' end)
      when l.action='membership.updated' then jsonb_build_object('user_id',case when jsonb_typeof(l.details->'user_id')='string' and l.details->>'user_id' ~ '^[a-f0-9-]{36}$' then l.details->>'user_id' end,
        'role',case when l.details->>'role' in ('admin','manager','closer','viewer') then l.details->>'role' end,
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

-- Legacy audit endpoint must not provide an alternate unfiltered route for Master.
create or replace function public.list_audit(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Acesso administrativo não autorizado.' using errcode='42501'; end if;
  if private.is_platform_admin() then return public.platform_list_administrative_audit(p_workspace_id); end if;
  if private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Acesso administrativo não autorizado.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(log) order by log.created_at desc),'[]') into result
    from (select id,actor_id,action,details,created_at from public.audit_logs where workspace_id=p_workspace_id order by created_at desc limit 200) log;
  return result;
end; $$;

create function public.platform_delete_workspace(p_workspace_id uuid,p_confirmation text,p_irreversible_confirmed boolean,p_authorization_confirmed boolean,p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$ declare workspace_name text; normalized_reason text:=btrim(p_reason);
begin
  perform private.assert_platform_workspace(p_workspace_id,true);
  select name into workspace_name from public.workspaces where id=p_workspace_id;
  if p_confirmation is distinct from workspace_name then raise exception 'Digite o nome exato da empresa para excluir.' using errcode='22023'; end if;
  -- There is no reliable production/test classification in the existing architecture:
  -- require appropriate authorization for every account, never infer it from its name.
  if p_irreversible_confirmed is distinct from true or p_authorization_confirmed is distinct from true then
    raise exception 'Confirme a exclusão irreversível e a autorização apropriada para esta empresa.' using errcode='22023';
  end if;
  if normalized_reason is null or length(normalized_reason) not between 10 and 500 or normalized_reason ~ '[[:cntrl:]]' then
    raise exception 'Informe um motivo administrativo de 10 a 500 caracteres, sem dados comerciais.' using errcode='22023';
  end if;
  insert into private.workspace_deletion_receipts(workspace_id,workspace_name,actor_id,reason,authorization_confirmed,irreversible_confirmed)
    values(p_workspace_id,workspace_name,auth.uid(),normalized_reason,true,true);
  -- Remove this tenant's old audit identifiers; the independent minimal receipt survives.
  delete from public.audit_logs where workspace_id=p_workspace_id;
  delete from public.workspaces where id=p_workspace_id;
  -- Auth users / profiles / memberships in other workspaces are never deleted.
end; $$;

create function public.platform_list_workspace_deletions() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  if auth.uid() is null or not private.is_platform_admin() then raise exception 'Acesso da plataforma não autorizado.' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.deleted_at desc) from
    (select id,workspace_id,workspace_name,actor_id,deleted_at,reason from private.workspace_deletion_receipts order by deleted_at desc limit 200) r),'[]');
end; $$;

-- Narrow Master integration operations follow below; existing company APIs/RLS stay unchanged.

create function public.platform_list_inbound_integrations(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb; begin
  perform private.assert_platform_workspace(p_workspace_id);
  select coalesce(jsonb_agg(private.inbound_integration_json(i) order by i.created_at desc,i.id),'[]') into result
    from public.inbound_integrations i where i.workspace_id=p_workspace_id;
  return result;
end; $$;

create function public.platform_create_inbound_integration(p_workspace_id uuid,p_name text,p_source text,p_stage_id uuid,p_owner_id uuid,p_field_mapping jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; raw_token text; selected_owner uuid:=coalesce(p_owner_id,auth.uid()); begin
  perform private.assert_platform_workspace(p_workspace_id,true);
  perform private.validate_inbound_config(p_workspace_id,p_name,p_source,p_stage_id,selected_owner,p_field_mapping);
  raw_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.inbound_integrations(workspace_id,name,source,stage_id,owner_id,field_mapping,token_hash,created_by)
    values(p_workspace_id,btrim(p_name),btrim(p_source),p_stage_id,selected_owner,p_field_mapping,encode(extensions.digest(raw_token,'sha256'),'hex'),auth.uid()) returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.created',jsonb_build_object('integration_id',item.id));
  return jsonb_build_object('integration',private.inbound_integration_json(item),'token',raw_token);
end; $$;

create function public.platform_update_inbound_integration(p_workspace_id uuid,p_integration_id uuid,p_name text,p_source text,p_stage_id uuid,p_owner_id uuid,p_field_mapping jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; selected_owner uuid:=coalesce(p_owner_id,auth.uid()); begin
  perform private.assert_platform_workspace(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if item.archived_at is not null then raise exception 'Integração arquivada não pode ser editada.' using errcode='23514'; end if;
  perform private.validate_inbound_config(p_workspace_id,p_name,p_source,p_stage_id,selected_owner,p_field_mapping);
  update public.inbound_integrations set name=btrim(p_name),source=btrim(p_source),stage_id=p_stage_id,owner_id=selected_owner,field_mapping=p_field_mapping
    where id=item.id returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.updated',jsonb_build_object('integration_id',item.id));
  return private.inbound_integration_json(item);
end; $$;

create function public.platform_set_inbound_integration_active(p_workspace_id uuid,p_integration_id uuid,p_active boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; begin
  perform private.assert_platform_workspace(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if p_active is null or (p_active and item.archived_at is not null) then raise exception 'Estado da integração inválido.' using errcode='23514'; end if;
  if p_active then perform private.validate_inbound_config(p_workspace_id,item.name,item.source,item.stage_id,item.owner_id,item.field_mapping); end if;
  update public.inbound_integrations set active=p_active where id=item.id returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.status_updated',jsonb_build_object('integration_id',item.id,'active',p_active));
  return private.inbound_integration_json(item);
end; $$;

create function public.platform_rotate_inbound_integration_token(p_workspace_id uuid,p_integration_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; raw_token text; begin
  perform private.assert_platform_workspace(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if item.archived_at is not null then raise exception 'Integração arquivada não pode redefinir credencial.' using errcode='23514'; end if;
  raw_token:=encode(extensions.gen_random_bytes(32),'hex');
  update public.inbound_integrations set token_hash=encode(extensions.digest(raw_token,'sha256'),'hex') where id=item.id returning * into item;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.token_rotated',jsonb_build_object('integration_id',item.id));
  return jsonb_build_object('integration',private.inbound_integration_json(item),'token',raw_token);
end; $$;

create function public.platform_archive_inbound_integration(p_workspace_id uuid,p_integration_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare item public.inbound_integrations; begin
  perform private.assert_platform_workspace(p_workspace_id,true);
  select * into item from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id for update;
  if not found then raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if item.archived_at is null then
    update public.inbound_integrations set active=false,archived_at=clock_timestamp() where id=item.id returning * into item;
    insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'integration.archived',jsonb_build_object('integration_id',item.id));
  end if;
  return private.inbound_integration_json(item);
end; $$;

create function public.platform_list_inbound_integration_logs(p_workspace_id uuid,p_integration_id uuid,p_before_id bigint default null,p_limit integer default 30) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare items jsonb; last_id bigint; more boolean; begin
  perform private.assert_platform_workspace(p_workspace_id);
  if not exists(select 1 from public.inbound_integrations where workspace_id=p_workspace_id and id=p_integration_id) then
    raise exception 'Integração não encontrada.' using errcode='P0002'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_id is not null and p_before_id<=0) then raise exception 'Paginação inválida.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id::text,'workspace_id',l.workspace_id,'integration_id',l.integration_id,'request_id',l.request_id,
    'status',l.status,'error_code',case when l.error_code in ('BODY_TOO_DEEP','BODY_TOO_LARGE','FIELD_INVALID','INVALID_BODY','INVALID_CREDENTIALS','NAME_REQUIRED','OWNER_UNAVAILABLE','RATE_LIMITED','SERVICE_UNAVAILABLE','STAGE_UNAVAILABLE','TICKET_INVALID','UNSAFE_PROPERTY','UNSUPPORTED_ENCODING','UNSUPPORTED_MEDIA_TYPE','WORKSPACE_UNAVAILABLE') then l.error_code else case when l.error_code is not null then 'TECHNICAL_ERROR' end end,'created_at',l.created_at) order by l.id desc),'[]'),min(l.id)
    into items,last_id from (select * from public.inbound_integration_logs where workspace_id=p_workspace_id and integration_id=p_integration_id
      and (p_before_id is null or id<p_before_id) order by id desc limit p_limit) l;
  select exists(select 1 from public.inbound_integration_logs where workspace_id=p_workspace_id and integration_id=p_integration_id and id<last_id) into more;
  return jsonb_build_object('items',items,'next_cursor',case when more then last_id::text else null end);
end; $$;

-- No implicit PUBLIC/anonymous execution, no grants on the receipt table or commercial tables.
revoke all on function private.assert_platform_workspace(uuid,boolean) from public,anon,authenticated;
grant execute on function private.assert_platform_workspace(uuid,boolean) to service_role;
revoke all on function public.platform_update_workspace_information(uuid,text,text),public.platform_inbound_options(uuid),
  public.platform_list_administrative_audit(uuid),public.platform_delete_workspace(uuid,text,boolean,boolean,text),public.platform_list_workspace_deletions(),
  public.platform_list_inbound_integrations(uuid),public.platform_create_inbound_integration(uuid,text,text,uuid,uuid,jsonb),
  public.platform_update_inbound_integration(uuid,uuid,text,text,uuid,uuid,jsonb),public.platform_set_inbound_integration_active(uuid,uuid,boolean),
  public.platform_rotate_inbound_integration_token(uuid,uuid),public.platform_archive_inbound_integration(uuid,uuid),
  public.platform_list_inbound_integration_logs(uuid,uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.platform_update_workspace_information(uuid,text,text),public.platform_inbound_options(uuid),
  public.platform_list_administrative_audit(uuid),public.platform_delete_workspace(uuid,text,boolean,boolean,text),public.platform_list_workspace_deletions(),
  public.platform_list_inbound_integrations(uuid),public.platform_create_inbound_integration(uuid,text,text,uuid,uuid,jsonb),
  public.platform_update_inbound_integration(uuid,uuid,text,text,uuid,uuid,jsonb),public.platform_set_inbound_integration_active(uuid,uuid,boolean),
  public.platform_rotate_inbound_integration_token(uuid,uuid),public.platform_archive_inbound_integration(uuid,uuid),
  public.platform_list_inbound_integration_logs(uuid,uuid,bigint,integer) to authenticated,service_role;
comment on function public.platform_inbound_options(uuid) is 'Master-only normal active stage IDs/names and assignable member IDs/names. No operational pipeline, lead, call, member email or commercial settings access.';
comment on function public.platform_list_inbound_integration_logs(uuid,uuid,bigint,integer) is 'Master-only technical diagnostics. Omits lead and duplicate lead IDs, personal data, form answers, credential hashes and raw payloads.';
comment on function public.platform_delete_workspace(uuid,text,boolean,boolean,text) is 'Locked tenant deletion with exact name, two independent explicit confirmations and mandatory reason. Preserves a private administrative receipt and shared Auth accounts.';
notify pgrst,'reload schema';
commit;
