\set ON_ERROR_STOP on
-- Run after the existing suites in the disposable harness database, never in production.
select test.ok(has_function_privilege('authenticated','public.update_my_display_name(text,uuid)','EXECUTE'),'account names: authenticated may invoke self-name RPC');
select test.ok(has_function_privilege('authenticated','public.update_member_display_name(uuid,uuid,text)','EXECUTE'),'account names: authenticated may invoke tenant alias RPC');
select test.ok(has_function_privilege('authenticated','public.rename_workspace(uuid,text)','EXECUTE'),'account names: authenticated may invoke company rename RPC');
select test.ok(not has_function_privilege('anon','public.update_my_display_name(text,uuid)','EXECUTE'),'account names: anonymous has no self-name RPC grant');
select test.ok(not has_function_privilege('anon','public.update_member_display_name(uuid,uuid,text)','EXECUTE'),'account names: anonymous has no tenant alias RPC grant');
select test.ok(not has_function_privilege('anon','public.rename_workspace(uuid,text)','EXECUTE'),'account names: anonymous has no company rename RPC grant');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in ('public','private') and a.grantee=0 and a.privilege_type='EXECUTE'),'account names: migration grants no implicit PUBLIC execution');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef and not ('search_path=""'=any(p.proconfig))),'account names: security definer functions retain empty search path');
select test.ok(has_column_privilege('authenticated','public.profiles','display_name','UPDATE'),'account names: legacy own profile name update grant remains');
select test.ok(not has_column_privilege('authenticated','public.profiles','email','UPDATE'),'account names: profile email update grant remains absent');
select test.ok(not has_column_privilege('authenticated','public.memberships','role','UPDATE'),'account names: membership role update grant remains absent');
select test.ok(not has_column_privilege('authenticated','public.memberships','display_name','UPDATE'),'account names: membership alias requires authorized RPC');

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'account-name-'||n||'@example.test',now(),
  jsonb_build_object('display_name','Global '||n,'full_name','Nome completo original '||n,
    'terms_version','2026-10-06','privacy_version','2026-10-06','custom_preferences',jsonb_build_object('locale','pt-BR','density','compact'))
from generate_series(40,45) n;
insert into test.context values('names_metadata_42',(select raw_user_meta_data::text from auth.users where id='00000000-0000-0000-0000-000000000042'));
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('names_ws_a',public.create_workspace('Empresa nomes A')::text),('names_ws_b',public.create_workspace('Empresa nomes B')::text);
select public.admin_update_subscription(test.value('names_ws_a')::uuid,'team','active',10);
select public.admin_update_subscription(test.value('names_ws_b')::uuid,'team','active',10);
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active,display_name)
select test.value('names_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,active,alias
from (values(40,'admin',true,'Administrador A'),(41,'manager',true,'Gestor A'),(42,'closer',true,'Closer A'),(43,'viewer',true,'Leitor A'),(45,'closer',false,'Ex-colaborador A')) s(n,member_role,active,alias);
insert into public.memberships(workspace_id,user_id,role,is_active,display_name)
select test.value('names_ws_b')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,true,alias
from (values(44,'admin','Administrador B'),(42,'closer','Closer B'),(45,'closer','Colaborador B')) s(n,member_role,alias);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000040' where id=test.value('names_ws_a')::uuid;
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000044' where id=test.value('names_ws_b')::uuid;

set role anon;
select test.denied('select public.update_my_display_name(''Nome anônimo'')','42501','account names: anonymous self-name update is denied');
select test.denied(format('select public.update_member_display_name(%L,%L,''Apelido anônimo'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'42501','account names: anonymous alias update is denied');
select test.denied(format('select public.rename_workspace(%L,''Empresa anônima'')',test.value('names_ws_a')),'42501','account names: anonymous company rename is denied');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','',false);
select test.denied('select public.update_my_display_name(''Nome sem sessão'')','42501','account names: missing identity cannot update own name');
select test.denied(format('select public.update_member_display_name(%L,%L,''Apelido sem sessão'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'42501','account names: missing identity cannot update member alias');
select test.denied(format('select public.rename_workspace(%L,''Empresa sem sessão'')',test.value('names_ws_a')),'42501','account names: missing identity cannot rename company');

-- Global self-name changes synchronize Auth and profile, while keeping all tenant aliases.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000042',false);
select public.update_my_display_name('  Nome global escolhido  ');
select test.ok((select display_name='Nome global escolhido' from public.profiles where id=auth.uid()),'account names: global self-name is trimmed in profile');
select test.ok((select display_name='Closer A' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id=auth.uid()),'account names: global name preserves company A alias');
select test.ok((select display_name='Closer B' from public.memberships where workspace_id=test.value('names_ws_b')::uuid and user_id=auth.uid()),'account names: global name preserves company B alias');
reset role;
select test.ok((select raw_user_meta_data=(test.value('names_metadata_42')::jsonb||jsonb_build_object('display_name','Nome global escolhido')) from auth.users where id='00000000-0000-0000-0000-000000000042'),'account names: self-name preserves full name policy and arbitrary Auth metadata');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000042',false);
select public.update_my_display_name('  Meu nome atualizado  ',test.value('names_ws_a')::uuid);
select test.ok((select display_name='Meu nome atualizado' from public.profiles where id=auth.uid()),'account names: scoped self-name updates own global profile');
select test.ok((select display_name is null from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id=auth.uid()),'account names: scoped self-name clears only current own alias');
select test.ok((select display_name='Closer B' from public.memberships where workspace_id=test.value('names_ws_b')::uuid and user_id=auth.uid()),'account names: scoped self-name leaves own other-company alias intact');
reset role;
select test.ok((select raw_user_meta_data=(test.value('names_metadata_42')::jsonb||jsonb_build_object('display_name','Meu nome atualizado')) from auth.users where id='00000000-0000-0000-0000-000000000042'),'account names: scoped self-name synchronizes Auth without dropping metadata');
select test.ok((select display_name='Gestor A' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000041'),'account names: scoped self-name leaves colleague alias intact');

-- A rejected scope must not update global profile or Auth before checking membership.
insert into test.context values('names_metadata_40',(select raw_user_meta_data::text from auth.users where id='00000000-0000-0000-0000-000000000040')),
  ('names_metadata_45',(select raw_user_meta_data::text from auth.users where id='00000000-0000-0000-0000-000000000045'));
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false);
select test.denied(format('select public.update_my_display_name(''Mutação indevida'',%L)',test.value('names_ws_b')),'42501','account names: foreign company scope is denied before global mutation');
select test.ok((select display_name='Global 40' from public.profiles where id=auth.uid()),'account names: foreign scope failure preserves own profile name');
select test.ok((select display_name='Administrador A' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id=auth.uid()),'account names: foreign scope failure preserves own valid-company alias');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000045',false);
select test.denied(format('select public.update_my_display_name(''Mutação de inativo'',%L)',test.value('names_ws_a')),'42501','account names: inactive company scope cannot update global name');
select test.ok((select display_name='Global 45' from public.profiles where id=auth.uid()),'account names: inactive scope failure preserves own profile name');
select test.ok((select display_name='Colaborador B' from public.memberships where workspace_id=test.value('names_ws_b')::uuid and user_id=auth.uid()),'account names: inactive scope failure leaves active other-company alias intact');
reset role;
select test.ok((select raw_user_meta_data=test.value('names_metadata_40')::jsonb from auth.users where id='00000000-0000-0000-0000-000000000040'),'account names: foreign scope failure preserves Auth metadata atomically');
select test.ok((select raw_user_meta_data=test.value('names_metadata_45')::jsonb from auth.users where id='00000000-0000-0000-0000-000000000045'),'account names: inactive scope failure preserves Auth metadata atomically');
select test.ok((select display_name='Ex-colaborador A' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000045'),'account names: inactive scope failure leaves inactive membership alias intact');

-- Self-name validation and exact inclusive boundaries.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000042',false);
select test.denied('select public.update_my_display_name(null)','22023','account names: null own display name is rejected');
select test.denied('select public.update_my_display_name('' '')','22023','account names: blank own display name is rejected');
select test.denied('select public.update_my_display_name(''A'')','22023','account names: one-character own display name is rejected');
select test.denied('select public.update_my_display_name(repeat(''a'',121))','22023','account names: overlong own display name is rejected');
select test.denied(format('select public.update_my_display_name(%L)',E'Nome\ncontrole'),'22023','account names: own display name newline is rejected');
select test.denied(format('select public.update_my_display_name(%L)','Nome'||chr(127)),'22023','account names: own display name DEL control is rejected');
select test.ok((select display_name='Meu nome atualizado' from public.profiles where id=auth.uid()),'account names: invalid own names leave profile unchanged');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000043',false);
select public.update_my_display_name('  Ab  ');
select test.ok((select display_name='Ab' from public.profiles where id=auth.uid()),'account names: minimum two-character self-name is accepted after trim');
select public.update_my_display_name(repeat('n',120));
select test.ok((select display_name=repeat('n',120) from public.profiles where id=auth.uid()),'account names: maximum 120-character self-name is accepted');

-- Tenant admins may set a local alias, without altering another person's Auth identity.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false);
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000042','  Apelido da equipe A  ');
select test.ok((select display_name='Apelido da equipe A' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: admin stores trimmed company-local member alias');
select test.ok((select display_name='Meu nome atualizado' from public.profiles where id='00000000-0000-0000-0000-000000000042'),'account names: admin alias never changes member global profile');
select test.ok((select entry->>'display_name'='Apelido da equipe A' from jsonb_array_elements(public.list_members(test.value('names_ws_a')::uuid)) entry where entry->>'user_id'='00000000-0000-0000-0000-000000000042'),'account names: company A roster returns effective local alias');
select test.denied(format('select public.update_member_display_name(%L,%L,''Pessoa de outra empresa'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000044'),'P0002','account names: company admin cannot rename a person absent from own company');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000042','Ab');
select test.ok((select display_name='Ab' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: minimum two-character member alias is accepted');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000042',repeat('a',120));
select test.ok((select display_name=repeat('a',120) from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: maximum 120-character member alias is accepted');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000042',null);
select test.ok((select entry->>'display_name'='Meu nome atualizado' from jsonb_array_elements(public.list_members(test.value('names_ws_a')::uuid)) entry where entry->>'user_id'='00000000-0000-0000-0000-000000000042'),'account names: cleared active-member alias falls back to global profile name');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000042','Apelido da equipe A');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000045','Nome do ex-colaborador');
select test.ok((select display_name='Nome do ex-colaborador' and not is_active from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000045'),'account names: administrator can rename an inactive member without reactivation');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000045',null);
select test.ok((select display_name is null and not is_active from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000045'),'account names: null alias clears only inactive member local override');
select test.ok((select entry->>'display_name'='Global 45' from jsonb_array_elements(public.list_members(test.value('names_ws_a')::uuid)) entry where entry->>'user_id'='00000000-0000-0000-0000-000000000045'),'account names: cleared local alias falls back to global profile name in roster');
select test.denied(format('select public.update_member_display_name(%L,%L,'' '')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'22023','account names: blank member alias is rejected');
select test.denied(format('select public.update_member_display_name(%L,%L,''A'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'22023','account names: one-character member alias is rejected');
select test.denied(format('select public.update_member_display_name(%L,%L,repeat(''a'',121))',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'22023','account names: overlong member alias is rejected');
select test.denied(format('select public.update_member_display_name(%L,%L,%L)',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042',E'Alias\tcontrole'),'22023','account names: member alias controls are rejected');
select test.ok((select display_name='Apelido da equipe A' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: invalid alias requests preserve existing alias');
select test.denied(format('select public.update_member_display_name(%L,%L,''Nome alheio'')',test.value('names_ws_b'),'00000000-0000-0000-0000-000000000042'),'42501','account names: company A admin cannot rename company B member');
select test.denied(format('select public.rename_workspace(%L,''Empresa alheia'')',test.value('names_ws_b')),'42501','account names: company A admin cannot rename company B');
reset role;
select test.ok((select raw_user_meta_data=(test.value('names_metadata_42')::jsonb||jsonb_build_object('display_name','Meu nome atualizado')) from auth.users where id='00000000-0000-0000-0000-000000000042'),'account names: admin member alias leaves member Auth metadata unchanged');
select test.ok((select display_name='Closer B' from public.memberships where workspace_id=test.value('names_ws_b')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: company A alias does not overwrite company B alias');
select test.ok((select display_name='Colaborador B' from public.memberships where workspace_id=test.value('names_ws_b')::uuid and user_id='00000000-0000-0000-0000-000000000045'),'account names: clearing inactive A alias preserves active B alias');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000044',false);
select test.ok((select entry->>'display_name'='Closer B' from jsonb_array_elements(public.list_members(test.value('names_ws_b')::uuid)) entry where entry->>'user_id'='00000000-0000-0000-0000-000000000042'),'account names: company B roster uses own local alias for shared closer');

-- Managers keep legacy presentation settings, but cannot rename people or the company.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000041',false);
select test.denied(format('select public.update_member_display_name(%L,%L,''Gestor indevido'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'42501','account names: manager cannot update a member alias');
select test.denied(format('select public.rename_workspace(%L,''Empresa por gestor'')',test.value('names_ws_a')),'42501','account names: manager cannot rename company through RPC');
update public.workspace_settings set name='Apresentação do gestor',commission_rate=21,revenue_goal=333000 where workspace_id=test.value('names_ws_a')::uuid;
select test.ok((select commission_rate=21 and revenue_goal=333000 and name='Apresentação do gestor' from public.workspace_settings where workspace_id=test.value('names_ws_a')::uuid),'account names: manager may update legacy presentation name and numeric settings');
select test.ok((select name='Empresa nomes A' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: legacy presentation name never renames canonical company');
select test.ok((select entry->>'display_name'='Apelido da equipe A' from jsonb_array_elements(public.list_members(test.value('names_ws_a')::uuid)) entry where entry->>'user_id'='00000000-0000-0000-0000-000000000042'),'account names: legacy manager roster read returns effective aliases');
select test.denied('update public.memberships set display_name=''Mutação direta'' where user_id=''00000000-0000-0000-0000-000000000042''','42501','account names: direct membership alias update stays forbidden');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000042',false);
select test.denied(format('select public.update_member_display_name(%L,%L,''Closer indevido'')',test.value('names_ws_a'),auth.uid()),'42501','account names: closer cannot invoke administrator alias RPC even for self');
select test.denied(format('select public.rename_workspace(%L,''Empresa por closer'')',test.value('names_ws_a')),'42501','account names: closer cannot rename company through RPC');
with changed as (update public.workspace_settings set name='Empresa por closer' where workspace_id=test.value('names_ws_a')::uuid returning workspace_id)
  select test.ok((select count(*)=0 from changed),'account names: direct closer settings rename changes no rows under RLS');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000043',false);
select test.denied(format('select public.update_member_display_name(%L,%L,''Leitor indevido'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'42501','account names: viewer cannot invoke member alias RPC');
select test.denied(format('select public.rename_workspace(%L,''Empresa por leitor'')',test.value('names_ws_a')),'42501','account names: viewer cannot rename company through RPC');
with changed as (update public.workspace_settings set name='Empresa por leitor' where workspace_id=test.value('names_ws_a')::uuid returning workspace_id)
  select test.ok((select count(*)=0 from changed),'account names: direct viewer settings rename changes no rows under RLS');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000045',false);
select test.denied(format('select public.update_member_display_name(%L,%L,''Inativo indevido'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'42501','account names: inactive member cannot invoke member alias RPC');
select test.denied(format('select public.rename_workspace(%L,''Empresa por inativo'')',test.value('names_ws_a')),'42501','account names: inactive member cannot rename company');

-- A platform role alone never confers permission to mutate a customer's names.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.denied(format('select public.update_member_display_name(%L,%L,''Operador indevido'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'42501','account names: platform role alone cannot update customer member alias');
select test.denied(format('select public.rename_workspace(%L,''Empresa por operador'')',test.value('names_ws_a')),'42501','account names: platform role alone cannot rename customer company');
with changed as (update public.workspace_settings set name='Empresa por operador' where workspace_id=test.value('names_ws_a')::uuid returning workspace_id)
  select test.ok((select count(*)=0 from changed),'account names: direct platform settings rename without membership changes no rows');
select test.ok((select entry->>'display_name'='Apelido da equipe A' from jsonb_array_elements(public.list_members(test.value('names_ws_a')::uuid)) entry where entry->>'user_id'='00000000-0000-0000-0000-000000000042'),'account names: legacy authorized platform roster read remains available');

-- Administrator company rename preserves legacy presentation and numeric settings.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false);
select public.rename_workspace(test.value('names_ws_a')::uuid,'  Nova empresa A  ');
select test.ok((select name='Nova empresa A' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: administrator rename trims company label');
select test.ok((select name='Apresentação do gestor' and commission_rate=21 and revenue_goal=333000 from public.workspace_settings where workspace_id=test.value('names_ws_a')::uuid),'account names: administrator company rename preserves presentation name and goals');
select public.rename_workspace(test.value('names_ws_a')::uuid,'Ab');
select test.ok((select name='Ab' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: two-character company name remains accepted');
select public.rename_workspace(test.value('names_ws_a')::uuid,repeat('e',120));
select test.ok((select name=repeat('e',120) from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: maximum 120-character company name is accepted');
select public.rename_workspace(test.value('names_ws_a')::uuid,'Nova empresa A');
select test.denied(format('select public.rename_workspace(%L,null)',test.value('names_ws_a')),'22023','account names: null company name is rejected');
select test.denied(format('select public.rename_workspace(%L,'' '')',test.value('names_ws_a')),'22023','account names: blank company name is rejected');
select public.rename_workspace(test.value('names_ws_a')::uuid,'  A  ');
select test.ok((select name='A' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: minimum one-character company name is accepted after trim');
select public.rename_workspace(test.value('names_ws_a')::uuid,'Nova empresa A');
select test.denied(format('select public.rename_workspace(%L,repeat(''a'',121))',test.value('names_ws_a')),'22023','account names: overlong company name is rejected');
select test.denied(format('select public.rename_workspace(%L,%L)',test.value('names_ws_a'),E'Empresa\ncontrole'),'22023','account names: company name controls are rejected');
select test.ok((select name='Nova empresa A' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: failed company rename leaves canonical label unchanged');
select test.ok((select name='Apresentação do gestor' and commission_rate=21 and revenue_goal=333000 from public.workspace_settings where workspace_id=test.value('names_ws_a')::uuid),'account names: failed company rename leaves presentation name and goals unchanged');
update public.workspace_settings set name='Nome via configuração' where workspace_id=test.value('names_ws_a')::uuid;
select test.ok((select name='Nova empresa A' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: administrator legacy presentation update leaves canonical company unchanged');
select test.ok((select name='Nome via configuração' and commission_rate=21 and revenue_goal=333000 from public.workspace_settings where workspace_id=test.value('names_ws_a')::uuid),'account names: administrator legacy presentation update preserves numeric settings');
select test.denied(format('update public.workspaces set name=''Mutação direta'' where id=%L',test.value('names_ws_a')),'42501','account names: direct canonical workspace update is still not granted');

-- Administrative names stay editable for active members while the subscription is paused.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.admin_update_subscription(test.value('names_ws_a')::uuid,'team','suspended',10);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false);
select public.rename_workspace(test.value('names_ws_a')::uuid,'Empresa pausada renomeada');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000042','Alias na empresa pausada');
select test.ok((select name='Empresa pausada renomeada' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: active administrator may rename paused company metadata');
select test.ok((select name='Nome via configuração' and commission_rate=21 and revenue_goal=333000 from public.workspace_settings where workspace_id=test.value('names_ws_a')::uuid),'account names: paused administrator company rename preserves presentation and goals');
select test.ok((select display_name='Alias na empresa pausada' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: active administrator may rename member in paused company');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000042',false);
select public.update_my_display_name('Nome em empresa pausada',test.value('names_ws_a')::uuid);
select test.ok((select display_name is null from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id=auth.uid()),'account names: active member self-name clears own alias in paused company');
select test.ok((select display_name='Closer B' from public.memberships where workspace_id=test.value('names_ws_b')::uuid and user_id=auth.uid()),'account names: paused scoped self-name preserves other-company alias');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.admin_update_subscription(test.value('names_ws_a')::uuid,'team','active',10);
reset role;

-- Explicit tenant membership permits the operator only in that one tenant.
insert into public.memberships(workspace_id,user_id,role,is_active) values(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000001','admin',true);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.rename_workspace(test.value('names_ws_a')::uuid,'Empresa por membro autorizado');
select public.update_member_display_name(test.value('names_ws_a')::uuid,'00000000-0000-0000-0000-000000000042','Alias por membro autorizado');
select test.ok((select name='Empresa por membro autorizado' from public.workspaces where id=test.value('names_ws_a')::uuid),'account names: platform operator with real admin membership may rename that company');
select test.ok((select display_name='Alias por membro autorizado' from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: platform operator with real admin membership may set that company alias');
select test.denied(format('select public.rename_workspace(%L,''Outra empresa indevida'')',test.value('names_ws_b')),'42501','account names: operator admin membership in A does not grant company B rename');
select test.denied(format('select public.update_member_display_name(%L,%L,''Outro alias indevido'')',test.value('names_ws_b'),'00000000-0000-0000-0000-000000000042'),'42501','account names: operator admin membership in A does not grant company B aliases');
reset role;
update public.memberships set is_active=false where workspace_id=test.value('names_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.denied(format('select public.rename_workspace(%L,''Empresa com admin inativo'')',test.value('names_ws_a')),'42501','account names: deactivated operator admin membership cannot rename company');
select test.denied(format('select public.update_member_display_name(%L,%L,''Alias com admin inativo'')',test.value('names_ws_a'),'00000000-0000-0000-0000-000000000042'),'42501','account names: deactivated operator admin membership cannot set aliases');
reset role;
select test.ok((select name='Empresa nomes B' from public.workspaces where id=test.value('names_ws_b')::uuid),'account names: all company A operations preserve company B label');
select test.ok((select name='Empresa nomes B' from public.workspace_settings where workspace_id=test.value('names_ws_b')::uuid),'account names: all company A operations preserve company B settings label');
select test.ok((select display_name='Closer B' from public.memberships where workspace_id=test.value('names_ws_b')::uuid and user_id='00000000-0000-0000-0000-000000000042'),'account names: all company A operations preserve company B member alias');

-- Preserve the original profile RLS and protected-column grants.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000042',false);
update public.profiles set display_name='Nome via perfil legado' where id=auth.uid();
select test.ok((select display_name='Nome via perfil legado' from public.profiles where id=auth.uid()),'account names: legacy direct own-profile display-name update remains allowed');
with changed as (update public.profiles set display_name='Nome alheio indevido' where id='00000000-0000-0000-0000-000000000041' returning id)
  select test.ok((select count(*)=0 from changed),'account names: legacy profile RLS denies colleague display-name mutation');
select test.denied('update public.profiles set email=''forged@example.test'' where id=auth.uid()','42501','account names: own-profile email still cannot be forged');
select test.denied('update public.memberships set role=''admin'' where user_id=auth.uid()','42501','account names: self-name changes never grant direct role update');
select test.denied('update auth.users set raw_user_meta_data=''{}''::jsonb where id=auth.uid()','42501','account names: clients cannot directly overwrite Auth metadata');
select test.ok((select email='account-name-41@example.test' and display_name='Global 41' from public.profiles where id='00000000-0000-0000-0000-000000000041'),'account names: authorized colleague profile reads retain original email and global name');
select test.ok((select role='closer' and is_active from public.memberships where workspace_id=test.value('names_ws_a')::uuid and user_id=auth.uid()),'account names: own global names never elevate tenant role');
select test.ok((select count(*)=0 from public.platform_admins),'account names: own global names never grant platform role');
reset role;
select test.ok(not exists(select 1 from public.audit_logs where action in ('profile.display_name_updated','membership.display_name_updated','workspace.renamed') and details::text ~ 'Nome global escolhido|Meu nome atualizado|Apelido da equipe A|Nova empresa A'),'account names: administrative name-change audit excludes personal and company names');
select 'Account name assertions passed: '||count(*) from test.results;
