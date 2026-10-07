-- Closer OS: tenant isolation, invitations, manual billing, and administrative audit.
-- Apply as the project database owner. No credentials belong in this migration.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public;
revoke create on schema public from public;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only the database owner / service_role may populate this installation setting.
create table public.bootstrap_settings (
  id boolean primary key default true check (id),
  allowed_emails text[] not null default '{}',
  enabled boolean not null default true
);
insert into public.bootstrap_settings(id) values (true);

create table public.platform_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  owner_id uuid references public.profiles(id) on delete restrict,
  privacy_contact_email text not null default '',
  retention_days integer not null default 365 check (retention_days between 1 and 3650),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete restrict,
  role text not null check (role in ('admin', 'manager', 'closer', 'viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(workspace_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id, workspace_id) where is_active;

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  name text not null default 'Meu workspace' check (length(btrim(name)) between 1 and 120),
  commission_rate numeric(5,2) not null default 10 check (commission_rate between 0 and 100),
  revenue_goal numeric(16,2) not null default 200000 check (revenue_goal > 0),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  plan text not null default 'individual' check (plan in ('individual', 'team')),
  status text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'cancelled', 'suspended', 'expired')),
  seat_limit integer not null default 1 check (seat_limit between 1 and 10000),
  trial_ends_at timestamptz default (now() + interval '14 days'),
  current_period_end timestamptz,
  billing_method text not null default 'manual' check (billing_method = 'manual'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'trial' or trial_ends_at is not null)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text not null check (role in ('admin', 'manager', 'closer', 'viewer')),
  token_hash text not null unique check (length(token_hash) = 64),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index invitations_workspace_idx on public.invitations(workspace_id, expires_at);
create unique index invitations_pending_email_idx on public.invitations(workspace_id, email)
  where accepted_at is null and revoked_at is null;

create table public.leads (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  id text not null check (length(id) between 1 and 200),
  owner_id uuid not null,
  data jsonb not null,
  lawful_basis text check (lawful_basis in ('consent', 'contract', 'legitimate_interest', 'legal_obligation')),
  consent_at timestamptz,
  retention_until timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(workspace_id, id),
  foreign key(workspace_id, owner_id) references public.memberships(workspace_id, user_id) on delete restrict,
  check (jsonb_typeof(data) = 'object' and data ->> 'id' = id),
  check (lawful_basis <> 'consent' or consent_at is not null)
);
create index leads_owner_idx on public.leads(workspace_id, owner_id);
create index leads_retention_idx on public.leads(workspace_id, retention_until);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_workspace_idx on public.audit_logs(workspace_id, created_at desc);

create table public.policy_acceptances (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  document_type text not null check (document_type in ('terms','privacy')),
  document_version text not null check (length(btrim(document_version)) between 1 and 120),
  accepted_at timestamptz not null default now(),
  unique(user_id,document_type,document_version)
);

create function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.platform_admins where user_id = auth.uid()); $$;

create function private.workspace_role(p_workspace_id uuid) returns text
language sql stable security definer set search_path = ''
as $$ select role from public.memberships where workspace_id = p_workspace_id and user_id = auth.uid() and is_active; $$;

create function private.can_manage_workspace(p_workspace_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_platform_admin() or coalesce(private.workspace_role(p_workspace_id) = 'admin', false); $$;

create function private.workspace_available(p_workspace_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.subscriptions s where s.workspace_id = p_workspace_id and
    ((s.status = 'active' and (s.current_period_end is null or s.current_period_end > statement_timestamp()))
      or (s.status = 'trial' and s.trial_ends_at > statement_timestamp()
          and (s.current_period_end is null or s.current_period_end > statement_timestamp()))));
$$;

create function private.can_read_lead(p_workspace_id uuid, p_owner_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.workspace_available(p_workspace_id) and
    (private.workspace_role(p_workspace_id) in ('admin', 'manager', 'viewer')
      or (private.workspace_role(p_workspace_id) = 'closer' and p_owner_id = auth.uid()));
$$;

create function private.can_write_lead(p_workspace_id uuid, p_owner_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.workspace_available(p_workspace_id) and
    (private.workspace_role(p_workspace_id) in ('admin', 'manager')
      or (private.workspace_role(p_workspace_id) = 'closer' and p_owner_id = auth.uid()));
$$;

create function private.assignable_owner(p_workspace_id uuid, p_owner_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.memberships where workspace_id = p_workspace_id and user_id = p_owner_id and is_active and role in ('admin', 'manager', 'closer')); $$;

create function private.can_read_profile(p_user_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_user_id = auth.uid() or private.is_platform_admin() or exists(
    select 1 from public.memberships me join public.memberships colleague using(workspace_id)
    where me.user_id = auth.uid() and me.is_active and colleague.user_id = p_user_id and colleague.is_active);
$$;

create function private.assert_manage(p_workspace_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'Workspace não encontrado.' using errcode = 'P0002'; end if;
  if auth.uid() is null or not private.can_manage_workspace(p_workspace_id) then
    raise exception 'Acesso administrativo não autorizado.' using errcode = '42501';
  end if;
end;
$$;

create function private.assert_available(p_workspace_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  if not private.workspace_available(p_workspace_id) then
    raise exception 'Assinatura inativa ou vencida. Contate o administrador.' using errcode = '42501';
  end if;
end; $$;

create function private.reserved_seats(p_workspace_id uuid) returns integer
language sql stable security definer set search_path = ''
as $$ select
  (select count(*)::integer from public.memberships where workspace_id = p_workspace_id and is_active) +
  (select count(*)::integer from public.invitations where workspace_id = p_workspace_id and accepted_at is null and revoked_at is null and expires_at > statement_timestamp()); $$;

create function private.valid_lead_data(p_data jsonb) returns boolean
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
alter table public.leads add constraint valid_lead_data check (private.valid_lead_data(data));

create function private.sync_auth_profile() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  insert into public.profiles(id,email,display_name) values(new.id,lower(coalesce(new.email,'')),coalesce(new.raw_user_meta_data ->> 'display_name',new.raw_user_meta_data ->> 'full_name',split_part(coalesce(new.email,''),'@',1)))
  on conflict(id) do update set email = excluded.email, display_name = excluded.display_name, updated_at = now();
  return new;
end; $$;
create trigger closer_os_auth_profile after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function private.sync_auth_profile();
insert into public.profiles(id,email,display_name)
select id,lower(coalesce(email,'')),coalesce(raw_user_meta_data ->> 'display_name',raw_user_meta_data ->> 'full_name',split_part(coalesce(email,''),'@',1)) from auth.users
on conflict(id) do nothing;

create function private.touch_updated_at() returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end; $$;
create trigger profile_touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger workspace_touch before update on public.workspaces for each row execute function private.touch_updated_at();
create trigger settings_touch before update on public.workspace_settings for each row execute function private.touch_updated_at();

create function private.prepare_lead() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  if tg_op = 'INSERT' then
    new.created_at := now(); new.created_by := auth.uid();
    if new.retention_until is null then select now() + (retention_days * interval '1 day') into new.retention_until from public.workspaces where id = new.workspace_id; end if;
  else
    if new.workspace_id <> old.workspace_id or new.id <> old.id then raise exception 'Não é possível mover um registro entre workspaces ou alterar seu ID.' using errcode = '42501'; end if;
    new.created_at := old.created_at; new.created_by := old.created_by;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end; $$;
create trigger lead_prepare before insert or update on public.leads for each row execute function private.prepare_lead();

create function private.audit_lead() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare ws uuid; lead_id text; record_owner uuid;
begin
  if tg_op = 'DELETE' then ws := old.workspace_id; lead_id := old.id; record_owner := old.owner_id;
  else ws := new.workspace_id; lead_id := new.id; record_owner := new.owner_id; end if;
  -- Parent workspace deletion cascades its CRM; keep only the administrative deletion event.
  if exists(select 1 from public.workspaces where id = ws) then
    insert into public.audit_logs(workspace_id,actor_id,action,details)
      values(ws,auth.uid(),'lead.' || lower(tg_op),jsonb_build_object('lead_id',lead_id,'owner_id',record_owner));
  end if;
  return null;
end; $$;
create trigger lead_audit after insert or update or delete on public.leads for each row execute function private.audit_lead();

-- Every public data table has RLS; service-only installation/billing writes have no client policy.
alter table public.profiles enable row level security;
alter table public.bootstrap_settings enable row level security;
alter table public.platform_admins enable row level security;
alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.subscriptions enable row level security;
alter table public.invitations enable row level security;
alter table public.leads enable row level security;
alter table public.audit_logs enable row level security;
alter table public.policy_acceptances enable row level security;

create policy profile_read on public.profiles for select to authenticated using(private.can_read_profile(id));
create policy profile_update_self on public.profiles for update to authenticated using(id = auth.uid()) with check(id = auth.uid());
create policy platform_admin_self on public.platform_admins for select to authenticated using(user_id = auth.uid());
create policy workspace_read on public.workspaces for select to authenticated using(private.workspace_role(id) is not null or private.is_platform_admin());
create policy membership_read on public.memberships for select to authenticated using(user_id = auth.uid() or private.can_manage_workspace(workspace_id) or private.workspace_role(workspace_id) = 'manager');
create policy settings_read on public.workspace_settings for select to authenticated using(private.workspace_role(workspace_id) is not null or private.is_platform_admin());
create policy settings_update on public.workspace_settings for update to authenticated using(private.workspace_role(workspace_id) in ('admin','manager') and private.workspace_available(workspace_id)) with check(private.workspace_role(workspace_id) in ('admin','manager') and private.workspace_available(workspace_id));
create policy subscription_read on public.subscriptions for select to authenticated using(private.workspace_role(workspace_id) is not null or private.is_platform_admin());
create policy leads_read on public.leads for select to authenticated using(private.can_read_lead(workspace_id,owner_id));
create policy leads_insert on public.leads for insert to authenticated with check(private.can_write_lead(workspace_id,owner_id) and private.assignable_owner(workspace_id,owner_id));
create policy leads_update on public.leads for update to authenticated using(private.can_write_lead(workspace_id,owner_id)) with check(private.can_write_lead(workspace_id,owner_id) and private.assignable_owner(workspace_id,owner_id));
create policy leads_delete on public.leads for delete to authenticated using(private.workspace_available(workspace_id) and private.workspace_role(workspace_id) in ('admin','manager'));
create policy audit_read on public.audit_logs for select to authenticated using(private.can_manage_workspace(workspace_id));
create policy policy_acceptance_read on public.policy_acceptances for select to authenticated using(user_id = auth.uid());

create function public.bootstrap_owner() returns boolean
language plpgsql security definer set search_path = ''
as $$ declare actor uuid := auth.uid(); verified_email text;
begin
  if actor is null then raise exception 'Autenticação necessária.' using errcode = '42501'; end if;
  lock table public.platform_admins in exclusive mode;
  if exists(select 1 from public.platform_admins where user_id = actor) then return true; end if;
  if exists(select 1 from public.platform_admins) then raise exception 'Administrador inicial já configurado.' using errcode = '42501'; end if;
  select lower(email) into verified_email from auth.users where id = actor and email_confirmed_at is not null;
  if verified_email is null or not exists(select 1 from public.bootstrap_settings s where s.id and s.enabled and verified_email = any(select lower(unnest(s.allowed_emails)))) then
    raise exception 'Conta não autorizada para a configuração inicial.' using errcode = '42501';
  end if;
  insert into public.platform_admins(user_id) values(actor);
  update public.bootstrap_settings set enabled = false where id;
  insert into public.audit_logs(actor_id,action) values(actor,'platform.bootstrap');
  return true;
end; $$;

create function public.setup_owner(p_name text default null) returns boolean
language plpgsql security definer set search_path = ''
as $$ begin
  perform public.bootstrap_owner();
  if p_name is not null then
    if length(btrim(p_name)) not between 1 and 120 then raise exception 'Nome inválido.' using errcode = '22023'; end if;
    update public.profiles set display_name = btrim(p_name) where id = auth.uid();
  end if;
  return true;
end; $$;

create function public.create_workspace(p_name text, p_owner_name text default null) returns uuid
language plpgsql security definer set search_path = ''
as $$ declare workspace uuid;
begin
  if auth.uid() is null or not private.is_platform_admin() then raise exception 'Somente o administrador da plataforma cria clientes.' using errcode = '42501'; end if;
  if length(btrim(p_name)) not between 1 and 120 or p_name is null then raise exception 'Nome de workspace inválido.' using errcode = '22023'; end if;
  insert into public.workspaces(name) values(btrim(p_name)) returning id into workspace;
  insert into public.workspace_settings(workspace_id,name) values(workspace,coalesce(nullif(btrim(p_owner_name),''),btrim(p_name)));
  insert into public.subscriptions(workspace_id) values(workspace);
  insert into public.audit_logs(workspace_id,actor_id,action) values(workspace,auth.uid(),'workspace.created');
  return workspace;
end; $$;

create function public.invite_member(p_workspace_id uuid, p_email text, p_role text default 'closer') returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare normalized_email text := lower(btrim(p_email)); invitation public.invitations%rowtype; raw_token text; max_seats integer;
begin
  perform private.assert_manage(p_workspace_id);
  perform private.assert_available(p_workspace_id);
  if p_role is null or p_role not in ('admin','manager','closer','viewer') or normalized_email is null or length(normalized_email) > 320 or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'E-mail ou papel inválido.' using errcode = '22023'; end if;
  if exists(select 1 from public.workspaces where id = p_workspace_id and owner_id is null) and p_role <> 'admin' then raise exception 'Convide primeiro o administrador da empresa.' using errcode = '22023'; end if;
  if exists(select 1 from public.memberships m join public.profiles p on p.id = m.user_id where m.workspace_id = p_workspace_id and m.is_active and lower(p.email) = normalized_email) then raise exception 'Essa pessoa já participa do workspace.' using errcode = '23505'; end if;
  -- Reissuing invalidates the previous token and releases its seat reservation.
  update public.invitations set revoked_at = now() where workspace_id = p_workspace_id and email = normalized_email and accepted_at is null and revoked_at is null;
  select seat_limit into max_seats from public.subscriptions where workspace_id = p_workspace_id;
  if private.reserved_seats(p_workspace_id) >= max_seats then raise exception 'Limite de acessos atingido. Revogue um convite ou ajuste o plano.' using errcode = '23514'; end if;
  raw_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.invitations(workspace_id,email,role,token_hash,invited_by)
    values(p_workspace_id,normalized_email,p_role,encode(extensions.digest(raw_token,'sha256'),'hex'),auth.uid()) returning * into invitation;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'invitation.created',jsonb_build_object('invitation_id',invitation.id,'role',p_role));
  return jsonb_build_object('id',invitation.id,'email',invitation.email,'role',invitation.role,'token',raw_token,'expires_at',invitation.expires_at);
end; $$;

create function public.list_invitation_preview(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return null; end if;
  select jsonb_build_object('email',i.email,'workspace_name',w.name,'role',i.role,'expires_at',i.expires_at) into result
    from public.invitations i join public.workspaces w on w.id = i.workspace_id
    where i.token_hash = encode(extensions.digest(p_token,'sha256'),'hex') and i.accepted_at is null and i.revoked_at is null and i.expires_at > statement_timestamp() and private.workspace_available(i.workspace_id);
  return result;
end; $$;

create function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = ''
as $$ declare invitation public.invitations%rowtype; verified_email text; workspace uuid; max_seats integer;
begin
  if auth.uid() is null or p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Convite inválido.' using errcode = '42501'; end if;
  select workspace_id into workspace from public.invitations where token_hash = encode(extensions.digest(p_token,'sha256'),'hex');
  if workspace is null then raise exception 'Convite inválido.' using errcode = '42501'; end if;
  perform 1 from public.workspaces where id = workspace for update;
  select * into invitation from public.invitations where token_hash = encode(extensions.digest(p_token,'sha256'),'hex') for update;
  if invitation.id is null or invitation.accepted_at is not null or invitation.revoked_at is not null or invitation.expires_at <= statement_timestamp() then raise exception 'Convite inválido ou expirado.' using errcode = '42501'; end if;
  select lower(email) into verified_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if verified_email is null or verified_email <> invitation.email then raise exception 'Confirme o e-mail correspondente ao convite.' using errcode = '42501'; end if;
  perform private.assert_available(workspace);
  select seat_limit into max_seats from public.subscriptions where workspace_id = workspace;
  if private.reserved_seats(workspace) > max_seats then raise exception 'Limite de acessos atingido.' using errcode = '23514'; end if;
  -- A previously accepted membership cannot be silently changed by an old invitation.
  if exists(select 1 from public.memberships where workspace_id = workspace and user_id = auth.uid() and is_active) then raise exception 'Conta já participa do workspace.' using errcode = '23505'; end if;
  insert into public.memberships(workspace_id,user_id,role,is_active) values(workspace,auth.uid(),invitation.role,true)
    on conflict(workspace_id,user_id) do update set role = excluded.role, is_active = true, updated_at = now();
  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = invitation.id;
  if invitation.role = 'admin' then update public.workspaces set owner_id = auth.uid() where id = workspace and owner_id is null; end if;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(workspace,auth.uid(),'invitation.accepted',jsonb_build_object('invitation_id',invitation.id,'role',invitation.role));
  return workspace;
end; $$;

create function public.revoke_invitation(p_workspace_id uuid, p_invitation_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  perform private.assert_manage(p_workspace_id);
  update public.invitations set revoked_at = now() where id = p_invitation_id and workspace_id = p_workspace_id and accepted_at is null and revoked_at is null;
  if not found then raise exception 'Convite pendente não encontrado.' using errcode = 'P0002'; end if;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'invitation.revoked',jsonb_build_object('invitation_id',p_invitation_id));
end; $$;

create function public.update_member(p_workspace_id uuid, p_user_id uuid, p_role text, p_is_active boolean) returns void
language plpgsql security definer set search_path = ''
as $$ declare previous public.memberships%rowtype; max_seats integer;
begin
  perform private.assert_manage(p_workspace_id);
  if p_role is null or p_role not in ('admin','manager','closer','viewer') or p_is_active is null then raise exception 'Papel ou estado inválido.' using errcode = '22023'; end if;
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

create function public.transfer_workspace_owner(p_workspace_id uuid, p_new_owner_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  perform private.assert_manage(p_workspace_id);
  if private.workspace_role(p_workspace_id) is distinct from 'admin' or not exists(select 1 from public.workspaces where id = p_workspace_id and owner_id = auth.uid()) then raise exception 'Somente o dono transfere a propriedade.' using errcode = '42501'; end if;
  if not exists(select 1 from public.memberships where workspace_id = p_workspace_id and user_id = p_new_owner_id and is_active and role = 'admin') then raise exception 'O novo dono precisa ser um administrador ativo.' using errcode = '23514'; end if;
  update public.workspaces set owner_id = p_new_owner_id where id = p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'workspace.owner_transferred',jsonb_build_object('owner_id',p_new_owner_id));
end; $$;

create function public.admin_update_subscription(p_workspace_id uuid, p_plan text, p_status text, p_seat_limit integer, p_current_period_end timestamptz default null, p_trial_ends_at timestamptz default null) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  if auth.uid() is null or not private.is_platform_admin() then raise exception 'Somente o administrador da plataforma altera planos.' using errcode = '42501'; end if;
  perform private.assert_manage(p_workspace_id);
  if p_plan is null or p_plan not in ('individual','team') or p_status is null or p_status not in ('trial','active','past_due','cancelled','suspended','expired') or p_seat_limit is null or p_seat_limit not between 1 and 10000 then raise exception 'Plano, estado ou assentos inválidos.' using errcode = '22023'; end if;
  if p_seat_limit < private.reserved_seats(p_workspace_id) then raise exception 'O novo limite é menor que os acessos e convites atuais.' using errcode = '23514'; end if;
  update public.subscriptions set plan = p_plan, status = p_status, seat_limit = p_seat_limit,
    current_period_end = p_current_period_end, trial_ends_at = coalesce(p_trial_ends_at,trial_ends_at,now() + interval '14 days'), updated_at = now()
    where workspace_id = p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'subscription.updated',jsonb_build_object('plan',p_plan,'status',p_status,'seat_limit',p_seat_limit));
end; $$;

create function public.import_leads(p_workspace_id uuid, p_leads jsonb, p_owner_id uuid default null) returns jsonb
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
    insert into public.leads(workspace_id,id,owner_id,data) values(p_workspace_id,item ->> 'id',assigned_owner,item) on conflict(workspace_id,id) do nothing;
    get diagnostics affected = row_count;
    imported := imported + affected;
  end loop;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'leads.imported',jsonb_build_object('imported',imported,'skipped',input_count - imported));
  return jsonb_build_object('imported',imported,'skipped',input_count - imported);
end; $$;

create function public.list_members(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or not (private.can_manage_workspace(p_workspace_id) or coalesce(private.workspace_role(p_workspace_id) = 'manager',false)) then raise exception 'Acesso administrativo não autorizado.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',p.email,'display_name',p.display_name,'role',m.role,'is_active',m.is_active) order by m.created_at),'[]') into result from public.memberships m join public.profiles p on p.id = m.user_id where m.workspace_id = p_workspace_id;
  return result;
end; $$;

create function public.list_invitations(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or not private.can_manage_workspace(p_workspace_id) then raise exception 'Acesso administrativo não autorizado.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email,'role',role,'expires_at',expires_at,'accepted_at',accepted_at,'revoked_at',revoked_at) order by created_at desc),'[]') into result from public.invitations where workspace_id = p_workspace_id;
  return result;
end; $$;

create function public.list_audit(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or not private.can_manage_workspace(p_workspace_id) then raise exception 'Acesso administrativo não autorizado.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(log) order by log.created_at desc),'[]') into result from (select id,actor_id,action,details,created_at from public.audit_logs where workspace_id = p_workspace_id order by created_at desc limit 200) log;
  return result;
end; $$;

create function public.list_platform_workspaces() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or not private.is_platform_admin() then raise exception 'Acesso da plataforma não autorizado.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'created_at',w.created_at,'owner_id',w.owner_id,'admin_email',p.email,
    'subscription',jsonb_build_object('plan',s.plan,'status',s.status,'seat_limit',s.seat_limit,'current_period_end',s.current_period_end,'trial_ends_at',s.trial_ends_at),
    'member_count',(select count(*) from public.memberships m where m.workspace_id = w.id and m.is_active)) order by w.created_at desc),'[]') into result
    from public.workspaces w join public.subscriptions s on s.workspace_id = w.id left join public.profiles p on p.id = w.owner_id;
  return result;
end; $$;

create function public.export_workspace(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb;
begin
  -- Portability remains available to the client's administrator after billing expires.
  if auth.uid() is null or private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Somente o administrador da empresa exporta o workspace.' using errcode = '42501'; end if;
  select jsonb_build_object('version',1,'exported_at',now(),'workspace_id',p_workspace_id,
    'leads',coalesce((select jsonb_agg(data order by created_at) from public.leads where workspace_id = p_workspace_id),'[]'),
    'settings',jsonb_build_object('name',s.name,'commissionRate',s.commission_rate,'revenueGoal',s.revenue_goal),
    'privacy',jsonb_build_object('retention_days',w.retention_days,'privacy_contact_email',w.privacy_contact_email),
    'lead_privacy',coalesce((select jsonb_agg(jsonb_build_object('id',id,'owner_id',owner_id,'lawful_basis',lawful_basis,'consent_at',consent_at,'retention_until',retention_until)) from public.leads where workspace_id = p_workspace_id),'[]')) into result
    from public.workspaces w join public.workspace_settings s on s.workspace_id = w.id where w.id = p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.exported');
  return result;
end; $$;

create function public.update_workspace_privacy(p_workspace_id uuid, p_retention_days integer, p_privacy_contact_email text) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  perform private.assert_manage(p_workspace_id);
  if private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Somente o administrador da empresa altera a política de privacidade.' using errcode = '42501'; end if;
  if p_retention_days is null or p_retention_days not between 1 and 3650 or p_privacy_contact_email is null or (p_privacy_contact_email <> '' and p_privacy_contact_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'Política de privacidade inválida.' using errcode = '22023'; end if;
  update public.workspaces set retention_days = p_retention_days, privacy_contact_email = lower(btrim(p_privacy_contact_email)) where id = p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.privacy_updated');
end; $$;

create function public.record_lead_privacy(p_workspace_id uuid, p_lead_id text, p_lawful_basis text,
  p_consent_at timestamptz default null, p_retention_until timestamptz default null) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  perform 1 from public.workspaces where id = p_workspace_id for update;
  -- Legal decisions are made by the client administrator, never implicitly by the platform.
  if auth.uid() is null or private.workspace_role(p_workspace_id) is distinct from 'admin' then
    raise exception 'Somente o administrador da empresa registra a base legal.' using errcode = '42501';
  end if;
  if p_lawful_basis is not null and p_lawful_basis not in ('consent','contract','legitimate_interest','legal_obligation') then
    raise exception 'Base legal inválida.' using errcode = '22023';
  end if;
  if (p_lawful_basis = 'consent' and p_consent_at is null) or p_consent_at > statement_timestamp() then
    raise exception 'Registre a data válida do consentimento.' using errcode = '22023';
  end if;
  update public.leads set lawful_basis = p_lawful_basis, consent_at = p_consent_at,
    retention_until = coalesce(p_retention_until,created_at + (select retention_days from public.workspaces where id = p_workspace_id) * interval '1 day')
    where workspace_id = p_workspace_id and id = p_lead_id;
  if not found then raise exception 'Lead não encontrado.' using errcode = 'P0002'; end if;
  insert into public.audit_logs(workspace_id,actor_id,action,details)
    values(p_workspace_id,auth.uid(),'lead.privacy_recorded',jsonb_build_object('lead_id',p_lead_id));
end; $$;

create function public.record_policy_acceptance(p_terms_version text, p_privacy_version text) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  if auth.uid() is null then raise exception 'Autenticação necessária.' using errcode = '42501'; end if;
  if p_terms_version is null or p_privacy_version is null or length(btrim(p_terms_version)) not between 1 and 120 or length(btrim(p_privacy_version)) not between 1 and 120 then raise exception 'Versão dos documentos inválida.' using errcode = '22023'; end if;
  insert into public.policy_acceptances(user_id,document_type,document_version)
    values(auth.uid(),'terms',btrim(p_terms_version)),(auth.uid(),'privacy',btrim(p_privacy_version)) on conflict(user_id,document_type,document_version) do nothing;
end; $$;

create function public.purge_expired_leads(p_workspace_id uuid) returns integer
language plpgsql security definer set search_path = ''
as $$ declare removed integer;
begin
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if auth.uid() is null or private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Somente o administrador da empresa aplica a retenção.' using errcode = '42501'; end if;
  delete from public.leads where workspace_id = p_workspace_id and retention_until <= statement_timestamp();
  get diagnostics removed = row_count;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(p_workspace_id,auth.uid(),'leads.retention_purged',jsonb_build_object('removed',removed));
  return removed;
end; $$;

create function public.delete_workspace(p_workspace_id uuid, p_confirmation text) returns void
language plpgsql security definer set search_path = ''
as $$ declare workspace_name text;
begin
  perform private.assert_manage(p_workspace_id);
  if private.workspace_role(p_workspace_id) is distinct from 'admin' then raise exception 'Somente o administrador da empresa exclui os dados do workspace.' using errcode = '42501'; end if;
  select name into workspace_name from public.workspaces where id = p_workspace_id;
  if p_confirmation is distinct from workspace_name then raise exception 'Digite o nome exato do workspace para excluir.' using errcode = '22023'; end if;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.deleted');
  delete from public.workspaces where id = p_workspace_id;
end; $$;

-- Remove implicit PUBLIC execution and grant only the narrowly intended API.
revoke all on public.profiles,public.bootstrap_settings,public.platform_admins,public.workspaces,public.memberships,
  public.workspace_settings,public.subscriptions,public.invitations,public.leads,public.audit_logs,public.policy_acceptances from anon, authenticated;
revoke all on public.audit_logs_id_seq, public.policy_acceptances_id_seq from anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.bootstrap_owner(), public.setup_owner(text), public.create_workspace(text,text),
  public.invite_member(uuid,text,text), public.list_invitation_preview(text), public.accept_invitation(text),
  public.revoke_invitation(uuid,uuid), public.update_member(uuid,uuid,text,boolean), public.transfer_workspace_owner(uuid,uuid),
  public.admin_update_subscription(uuid,text,text,integer,timestamptz,timestamptz), public.import_leads(uuid,jsonb,uuid),
  public.list_members(uuid), public.list_invitations(uuid), public.list_audit(uuid), public.list_platform_workspaces(),
  public.export_workspace(uuid), public.update_workspace_privacy(uuid,integer,text), public.purge_expired_leads(uuid),
  public.delete_workspace(uuid,text), public.record_lead_privacy(uuid,text,text,timestamptz,timestamptz), public.record_policy_acceptance(text,text) from public, anon, authenticated;

grant usage on schema public, private to authenticated;
grant usage on schema public to anon;
grant select on public.profiles, public.platform_admins, public.workspaces, public.memberships, public.workspace_settings, public.subscriptions, public.audit_logs, public.policy_acceptances to authenticated;
grant update(display_name) on public.profiles to authenticated;
grant update(name,commission_rate,revenue_goal) on public.workspace_settings to authenticated;
grant select, delete on public.leads to authenticated;
grant insert(workspace_id,id,owner_id,data), update(data,owner_id) on public.leads to authenticated;
grant execute on function private.is_platform_admin(), private.workspace_role(uuid), private.can_manage_workspace(uuid),
  private.workspace_available(uuid), private.can_read_lead(uuid,uuid), private.can_write_lead(uuid,uuid), private.assignable_owner(uuid,uuid),
  private.can_read_profile(uuid), private.valid_lead_data(jsonb) to authenticated;
grant execute on function public.bootstrap_owner(), public.setup_owner(text), public.create_workspace(text,text),
  public.invite_member(uuid,text,text), public.list_invitation_preview(text), public.accept_invitation(text),
  public.revoke_invitation(uuid,uuid), public.update_member(uuid,uuid,text,boolean), public.transfer_workspace_owner(uuid,uuid),
  public.admin_update_subscription(uuid,text,text,integer,timestamptz,timestamptz), public.import_leads(uuid,jsonb,uuid),
  public.list_members(uuid), public.list_invitations(uuid), public.list_audit(uuid), public.list_platform_workspaces(),
  public.export_workspace(uuid), public.update_workspace_privacy(uuid,integer,text), public.purge_expired_leads(uuid),
  public.delete_workspace(uuid,text), public.record_lead_privacy(uuid,text,text,timestamptz,timestamptz), public.record_policy_acceptance(text,text) to authenticated;
grant execute on function public.list_invitation_preview(text) to anon;
grant all on public.profiles,public.bootstrap_settings,public.platform_admins,public.workspaces,public.memberships,
  public.workspace_settings,public.subscriptions,public.invitations,public.leads,public.audit_logs,public.policy_acceptances to service_role;
grant all on public.audit_logs_id_seq, public.policy_acceptances_id_seq to service_role;
grant usage on schema private to service_role;
grant execute on all functions in schema public, private to service_role;

comment on table public.bootstrap_settings is 'Service-only installation allowlist. Never derived from VITE_* environment variables or user metadata.';
comment on table public.leads is 'Lead payload preserves legacy string IDs. Tenant and responsible user are protected columns outside the JSON payload. Lawful basis defaults to NULL: the controller must establish and record the appropriate basis.';
comment on table public.audit_logs is 'Administrative metadata only. Lead names, contact details, call summaries, passwords, and invitation tokens must not be logged.';
comment on function public.list_invitation_preview(text) is 'Public token-bound preview. It cannot enumerate invitations, expose hashes, or accept expired/revoked tokens.';

commit;
