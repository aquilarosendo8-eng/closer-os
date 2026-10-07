-- Add named invitations and explicit invitation lifecycle states without changing migration 001.
begin;

alter table public.invitations add column display_name text;
alter table public.invitations add constraint invitation_display_name_valid
  check(display_name is null or (display_name=btrim(display_name) and length(display_name) between 2 and 120 and display_name ~ '[^[:space:]]' and display_name !~ '[[:cntrl:]]'));

-- A single four-argument function with a trailing default keeps old three-argument calls valid.
-- Keeping both signatures would make PostgREST resolution ambiguous.
drop function public.invite_member(uuid,text,text);

create function public.invite_member(p_workspace_id uuid, p_email text, p_role text default 'closer', p_name text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare normalized_email text := lower(btrim(p_email)); normalized_name text := case when p_name is null then null else btrim(p_name) end; invitation public.invitations%rowtype; raw_token text; max_seats integer;
begin
  perform private.assert_manage(p_workspace_id);
  perform private.assert_available(p_workspace_id);
  if p_role is null or p_role not in ('admin','manager','closer','viewer') or normalized_email is null or length(normalized_email) > 320 or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'E-mail ou papel inválido.' using errcode = '22023'; end if;
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

create or replace function public.list_invitation_preview(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return null; end if;
  select jsonb_build_object('name',i.display_name,'email',i.email,'workspace_name',w.name,'role',i.role,'expires_at',i.expires_at) into result
    from public.invitations i join public.workspaces w on w.id = i.workspace_id
    where i.token_hash = encode(extensions.digest(p_token,'sha256'),'hex') and i.accepted_at is null and i.revoked_at is null and i.expires_at > statement_timestamp() and private.workspace_available(i.workspace_id);
  return result;
end; $$;

create or replace function public.accept_invitation(p_token text) returns uuid
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
  -- Preserve a name chosen by the account holder; fill only the initial email-derived profile.
  if invitation.display_name is not null then
    update public.profiles set display_name = invitation.display_name where id = auth.uid()
      and (btrim(display_name) = '' or display_name = split_part(verified_email,'@',1));
  end if;
  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = invitation.id;
  if invitation.role = 'admin' then update public.workspaces set owner_id = auth.uid() where id = workspace and owner_id is null; end if;
  insert into public.audit_logs(workspace_id,actor_id,action,details) values(workspace,auth.uid(),'invitation.accepted',jsonb_build_object('invitation_id',invitation.id,'role',invitation.role));
  return workspace;
end; $$;

create or replace function public.list_invitations(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  if auth.uid() is null or not private.can_manage_workspace(p_workspace_id) then raise exception 'Acesso administrativo não autorizado.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.display_name,'email',i.email,'role',i.role,
    'expires_at',i.expires_at,'accepted_at',i.accepted_at,'accepted_by',i.accepted_by,'revoked_at',i.revoked_at,
    'status',case
      when i.accepted_at is not null then case when exists(select 1 from public.memberships m where m.workspace_id=i.workspace_id and m.user_id=i.accepted_by and m.is_active) then 'activated' else 'deactivated' end
      when i.revoked_at is not null then 'revoked'
      when i.expires_at <= statement_timestamp() then 'expired'
      else 'pending' end) order by i.created_at desc),'[]') into result
    from public.invitations i where i.workspace_id = p_workspace_id;
  return result;
end; $$;

revoke all on function public.invite_member(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.invite_member(uuid,text,text,text) to authenticated,service_role;
revoke all on function public.list_invitation_preview(text) from public,anon,authenticated;
grant execute on function public.list_invitation_preview(text) to anon,authenticated,service_role;
revoke all on function public.accept_invitation(text), public.list_invitations(uuid) from public,anon,authenticated;
grant execute on function public.accept_invitation(text), public.list_invitations(uuid) to authenticated,service_role;

comment on column public.invitations.display_name is 'Optional invited display name. User-chosen profile names are preserved at acceptance. Never written to administrative audit.';
comment on function public.invite_member(uuid,text,text,text) is 'Named invitations; old three-argument calls remain supported by the trailing name default. Each reissue invalidates the previous token.';
notify pgrst, 'reload schema';
commit;
