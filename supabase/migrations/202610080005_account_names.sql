-- Names in a company are optional aliases, independent of the account's global name.
-- Existing workspace_settings.name remains its legacy presentation setting.
begin;

alter table public.memberships add column display_name text;
alter table public.memberships add constraint membership_display_name_valid check(
  display_name is null or (display_name=btrim(display_name) and length(display_name) between 2 and 120
    and display_name ~ '[^[:space:]]' and display_name !~ '[[:cntrl:]]')
);

create function private.checked_account_name(p_name text,p_min_length integer default 2) returns text
language plpgsql immutable set search_path = ''
as $$ declare normalized text:=btrim(p_name);
begin
  if normalized is null or length(normalized) not between p_min_length and 120 or normalized !~ '[^[:space:]]' or normalized ~ '[[:cntrl:]]' then
    raise exception 'Informe um nome de % a 120 caracteres, sem caracteres de controle.',p_min_length using errcode='22023';
  end if;
  return normalized;
end; $$;

create function public.update_my_display_name(p_display_name text,p_workspace_id uuid default null) returns void
language plpgsql security definer set search_path = ''
as $$ declare actor uuid:=auth.uid(); normalized text;
begin
  if actor is null then raise exception 'Autenticação necessária.' using errcode='42501'; end if;
  normalized:=private.checked_account_name(p_display_name);
  -- Validate company context before changing the account. A foreign/inactive membership
  -- cannot cause a partially successful global name update.
  if p_workspace_id is not null then
    perform 1 from public.workspaces where id=p_workspace_id for update;
    if not found or not exists(select 1 from public.memberships where workspace_id=p_workspace_id and user_id=actor and is_active) then
      raise exception 'Você não possui acesso ativo a esta empresa.' using errcode='42501';
    end if;
  end if;
  -- Keep the official Auth -> profile trigger as the synchronization source. Do not lock
  -- profiles first: Auth itself locks auth.users before syncing profiles.
  update auth.users set raw_user_meta_data=jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb),'{display_name}',to_jsonb(normalized),true)
    where id=actor;
  if not found then raise exception 'Conta não encontrada.' using errcode='42501'; end if;
  if p_workspace_id is not null then
    update public.memberships set display_name=null,updated_at=now() where workspace_id=p_workspace_id and user_id=actor;
  end if;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,actor,'profile.display_name_updated');
end; $$;

create function public.update_member_display_name(p_workspace_id uuid,p_user_id uuid,p_display_name text) returns void
language plpgsql security definer set search_path = ''
as $$ declare normalized text;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária.' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found or private.workspace_role(p_workspace_id) is distinct from 'admin' then
    raise exception 'Somente o administrador ativo desta empresa altera nomes de membros.' using errcode='42501';
  end if;
  if p_display_name is not null then normalized:=private.checked_account_name(p_display_name); end if;
  update public.memberships set display_name=normalized,updated_at=now() where workspace_id=p_workspace_id and user_id=p_user_id;
  if not found then raise exception 'Membro não encontrado nesta empresa.' using errcode='P0002'; end if;
  insert into public.audit_logs(workspace_id,actor_id,action,details)
    values(p_workspace_id,auth.uid(),'membership.display_name_updated',jsonb_build_object('user_id',p_user_id,'alias_cleared',normalized is null));
end; $$;

create function public.rename_workspace(p_workspace_id uuid,p_name text) returns void
language plpgsql security definer set search_path = ''
as $$ declare normalized text;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária.' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found or private.workspace_role(p_workspace_id) is distinct from 'admin' then
    raise exception 'Somente o administrador ativo desta empresa altera seu nome.' using errcode='42501';
  end if;
  normalized:=private.checked_account_name(p_name,1);
  update public.workspaces set name=normalized where id=p_workspace_id;
  insert into public.audit_logs(workspace_id,actor_id,action) values(p_workspace_id,auth.uid(),'workspace.renamed');
end; $$;

create or replace function public.list_members(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ declare result jsonb;
begin
  -- Preserve the previous read policy, including managers and platform support metadata.
  if auth.uid() is null or not (private.can_manage_workspace(p_workspace_id) or coalesce(private.workspace_role(p_workspace_id)='manager',false)) then
    raise exception 'Acesso administrativo não autorizado.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',p.email,'display_name',coalesce(m.display_name,p.display_name),
    'role',m.role,'is_active',m.is_active) order by m.created_at),'[]') into result
    from public.memberships m join public.profiles p on p.id=m.user_id where m.workspace_id=p_workspace_id;
  return result;
end; $$;

-- Do not grant table updates to memberships. Aliases can only be changed by the scoped RPCs.
revoke all on function private.checked_account_name(text,integer) from public,anon,authenticated;
grant execute on function private.checked_account_name(text,integer) to service_role;
revoke all on function public.update_my_display_name(text,uuid),public.update_member_display_name(uuid,uuid,text),public.rename_workspace(uuid,text) from public,anon,authenticated;
grant execute on function public.update_my_display_name(text,uuid),public.update_member_display_name(uuid,uuid,text),public.rename_workspace(uuid,text) to authenticated,service_role;

comment on column public.memberships.display_name is 'Company-specific optional name. An administrator cannot change the global Auth/profile name or names used in other companies.';
comment on function public.update_my_display_name(text,uuid) is 'Updates only the current account name; optional active company context clears only its own alias in that company. Auth metadata unrelated to the name is preserved.';
comment on function public.rename_workspace(uuid,text) is 'Changes the company identity name only. The legacy presentation setting and commercial targets remain unchanged.';
notify pgrst,'reload schema';
commit;
