-- Editing oneself from the company roster uses the same personal-name rule as
-- My Account. Administrators still edit other people through a company alias.
begin;

create or replace function public.setup_owner(p_name text default null) returns boolean
language plpgsql security definer set search_path = ''
as $$ declare normalized text;
begin
  perform public.bootstrap_owner();
  if p_name is not null then
    normalized:=btrim(p_name);
    if length(normalized) not between 1 and 120 then raise exception 'Nome inválido.' using errcode='22023'; end if;
    -- A stale browser session is not a personal-name editor. Retain the legacy
    -- optional seed only for an unset profile, synchronized through Auth.
    -- Lock Auth before the profile, like update_my_display_name's trigger path.
    perform 1 from auth.users where id=auth.uid() for update;
    perform 1 from public.profiles where id=auth.uid() and nullif(btrim(display_name),'') is null for update;
    if found then
      update auth.users set raw_user_meta_data=jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb),'{display_name}',to_jsonb(normalized),true)
        where id=auth.uid();
    end if;
  end if;
  return true;
end; $$;

create or replace function public.update_member_display_name(p_workspace_id uuid,p_user_id uuid,p_display_name text) returns void
language plpgsql security definer set search_path = ''
as $$ declare normalized text;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária.' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found or private.workspace_role(p_workspace_id) is distinct from 'admin' then
    raise exception 'Somente o administrador ativo desta empresa altera nomes de membros.' using errcode='42501';
  end if;
  if p_user_id=auth.uid() and p_display_name is not null then
    -- Reuse Auth -> profile synchronization and clear only this account's
    -- selected-company alias. Preserve all other companies and metadata.
    perform public.update_my_display_name(p_display_name,p_workspace_id);
    return;
  end if;
  -- NULL keeps the existing explicit alias-reset behavior; it never invents
  -- or changes a personal name. Other members retain company-local aliases.
  if p_display_name is not null then normalized:=private.checked_account_name(p_display_name); end if;
  update public.memberships set display_name=normalized,updated_at=now() where workspace_id=p_workspace_id and user_id=p_user_id;
  if not found then raise exception 'Membro não encontrado nesta empresa.' using errcode='P0002'; end if;
  insert into public.audit_logs(workspace_id,actor_id,action,details)
    values(p_workspace_id,auth.uid(),'membership.display_name_updated',jsonb_build_object('user_id',p_user_id,'alias_cleared',normalized is null));
end; $$;

-- CREATE OR REPLACE preserves the existing EXECUTE ACL. No table permissions,
-- policies or bootstrap/role checks change in this migration.
comment on function public.setup_owner(text) is 'Runs the existing owner bootstrap and optionally seeds only an unset personal name through Auth synchronization. Session metadata cannot overwrite an existing profile name.';
comment on function public.update_member_display_name(uuid,uuid,text) is 'An active company administrator edits their own non-null name through update_my_display_name; other members use a company-only alias. NULL resets only the selected company alias.';
comment on column public.memberships.display_name is 'Company-specific optional name. Editing another member changes only this alias, never their global Auth/profile name or aliases in other companies. Editing oneself uses the canonical personal-name path and clears only the selected company alias.';
notify pgrst,'reload schema';
commit;
