-- Verified customers may create one private trial workspace without platform privileges.
-- This ledger survives workspace deletion, so deleting a trial cannot reset its allowance.
begin;

create table private.self_service_registrations (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  workspace_id uuid unique references public.workspaces(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table private.self_service_registrations enable row level security;
revoke all on private.self_service_registrations from public, anon, authenticated;
grant all on private.self_service_registrations to service_role;

create function public.create_own_workspace(
  p_name text,
  p_display_name text,
  p_accept_terms boolean default false
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  workspace uuid;
begin
  if actor is null then
    raise exception 'Autenticação necessária.' using errcode = '42501';
  end if;
  -- All concurrent requests for this account serialize on its existing profile.
  perform 1 from public.profiles where id = actor for update;
  if not found or not exists(
    select 1 from auth.users
      where id = actor and email_confirmed_at is not null and nullif(btrim(email),'') is not null
  ) then
    raise exception 'Confirme seu e-mail antes de criar sua empresa.' using errcode = '42501';
  end if;
  if p_accept_terms is distinct from true then
    raise exception 'Aceite os termos de uso e a política de privacidade.' using errcode = '22023';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120 or p_name !~ '[^[:space:]]' or p_name ~ '[[:cntrl:]]'
    or p_display_name is null or length(btrim(p_display_name)) not between 1 and 120 or p_display_name !~ '[^[:space:]]' or p_display_name ~ '[[:cntrl:]]' then
    raise exception 'Informe nomes válidos de 1 a 120 caracteres.' using errcode = '22023';
  end if;

  select workspace_id into workspace from private.self_service_registrations where user_id = actor;
  if found then
    if workspace is null then
      raise exception 'Seu período de teste já foi utilizado. Contate o administrador para obter um novo acesso.'
        using errcode = '23514';
    end if;
    return workspace;
  end if;

  insert into public.workspaces(name,owner_id) values(btrim(p_name),actor) returning id into workspace;
  insert into public.memberships(workspace_id,user_id,role,is_active) values(workspace,actor,'admin',true);
  insert into public.workspace_settings(workspace_id,name) values(workspace,btrim(p_name));
  -- The existing subscription defaults enforce individual, one seat and a 14-day trial.
  insert into public.subscriptions(workspace_id) values(workspace);
  update public.profiles set display_name = btrim(p_display_name) where id = actor;
  perform public.record_policy_acceptance('2026-10-06','2026-10-06');
  insert into private.self_service_registrations(user_id,workspace_id) values(actor,workspace);
  insert into public.audit_logs(workspace_id,actor_id,action) values(workspace,actor,'workspace.self_service_created');
  return workspace;
end;
$$;

revoke all on function public.create_own_workspace(text,text,boolean) from public, anon, authenticated;
grant execute on function public.create_own_workspace(text,text,boolean) to authenticated, service_role;

comment on table private.self_service_registrations is 'Service-only trial allowance ledger. A deleted workspace leaves a NULL workspace_id tombstone; deleting the Auth identity cascades through its profile.';
comment on function public.create_own_workspace(text,text,boolean) is 'Creates at most one private individual trial for the authenticated, email-confirmed customer. Requires explicit policy acceptance; never grants platform administration.';

notify pgrst, 'reload schema';
commit;
