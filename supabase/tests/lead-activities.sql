\set ON_ERROR_STOP on
-- Activities/Lead 360 integration checks in the disposable database only.
select test.ok((select relrowsecurity from pg_class where oid='public.activities'::regclass),'lead activities: activity table enables RLS');
select test.ok((select relrowsecurity from pg_class where oid='public.lead_events'::regclass),'lead activities: timeline table enables RLS');
select test.ok(has_table_privilege('authenticated','public.activities','SELECT'),'lead activities: authenticated may read activities through RLS');
select test.ok(has_table_privilege('authenticated','public.lead_events','SELECT'),'lead activities: authenticated may read timeline through RLS');
select test.ok(not has_table_privilege('authenticated','public.activities','INSERT,UPDATE,DELETE'),'lead activities: raw activity mutation is not granted');
select test.ok(not has_table_privilege('authenticated','public.lead_events','INSERT,UPDATE,DELETE'),'lead activities: raw timeline mutation is not granted');
select test.ok(not has_table_privilege('anon','public.activities','SELECT'),'lead activities: anonymous cannot read activity table');
select test.ok(not has_table_privilege('anon','public.lead_events','SELECT'),'lead activities: anonymous cannot read timeline table');
select test.ok(has_function_privilege('authenticated','public.save_activity(uuid,text,text,text,timestamptz,uuid,text,uuid)','EXECUTE'),'lead activities: authenticated has scoped activity save RPC');
select test.ok(has_function_privilege('authenticated','public.set_activity_status(uuid,uuid,text)','EXECUTE'),'lead activities: authenticated has scoped status RPC');
select test.ok(not has_function_privilege('anon','public.save_activity(uuid,text,text,text,timestamptz,uuid,text,uuid)','EXECUTE'),'lead activities: anonymous has no activity save execution grant');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in ('public','private') and a.grantee=0 and a.privilege_type='EXECUTE'),'lead activities: new functions grant no implicit PUBLIC execution');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef and not ('search_path=""'=any(p.proconfig))),'lead activities: security definer functions retain empty search path');

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'activities-'||n||'@example.test',now(),jsonb_build_object('display_name','Pessoa atividades '||n)
from generate_series(60,67) n;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('activities_ws_a',public.create_workspace('Empresa atividades A')::text),('activities_ws_b',public.create_workspace('Empresa atividades B')::text);
select public.admin_update_subscription(test.value('activities_ws_a')::uuid,'team','active',10);
select public.admin_update_subscription(test.value('activities_ws_b')::uuid,'team','active',10);
reset role;

insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('activities_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,active
from (values(60,'admin',true),(61,'manager',true),(62,'closer',true),(63,'viewer',true),(65,'closer',true),(66,'closer',false)) s(n,member_role,active);
insert into public.memberships(workspace_id,user_id,role)
select test.value('activities_ws_b')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role
from (values(64,'admin'),(67,'closer')) s(n,member_role);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000060' where id=test.value('activities_ws_a')::uuid;
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000064' where id=test.value('activities_ws_b')::uuid;
insert into test.context
select 'activities_normal_stage',id::text from public.pipeline_stages where workspace_id=test.value('activities_ws_a')::uuid and name='Lead novo';
insert into test.context
select 'activities_won_stage',id::text from public.pipeline_stages where workspace_id=test.value('activities_ws_a')::uuid and type='WON';
insert into test.context
select 'activities_lost_stage',id::text from public.pipeline_stages where workspace_id=test.value('activities_ws_a')::uuid and type='LOST';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('activities_ws_a')::uuid,'activities-own',auth.uid(),test.lead('activities-own')),
  (test.value('activities_ws_a')::uuid,'activities-purge',auth.uid(),test.lead('activities-purge'));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000065',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('activities_ws_a')::uuid,'activities-other',auth.uid(),test.lead('activities-other'));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('activities_ws_a')::uuid,'activities-admin',auth.uid(),test.lead('activities-admin'));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000067',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('activities_ws_b')::uuid,'activities-foreign',auth.uid(),test.lead('activities-foreign'));
reset role;

set role anon;
select test.denied('select * from public.activities','42501','lead activities: anonymous cannot read task records');
select test.denied('select * from public.lead_events','42501','lead activities: anonymous cannot read commercial history');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Sem login'',''follow_up'',now())',test.value('activities_ws_a')),'42501','lead activities: anonymous cannot create task');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','',false);
select test.denied(format('select public.save_activity(%L,''activities-own'',''Sem sessão'',''follow_up'',now())',test.value('activities_ws_a')),'42501','lead activities: missing identity cannot create task');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
insert into test.context values('activities_main',public.save_activity(test.value('activities_ws_a')::uuid,'activities-own','  Validar decisão do sócio  ','follow_up',now()-interval '2 days',null,'Retomar a proposta.')->>'id');
select test.ok((select title='Validar decisão do sócio' and type='follow_up' and description='Retomar a proposta.' from public.activities where id=test.value('activities_main')::uuid),'lead activities: closer creates trimmed follow-up on own lead');
select test.ok((select status='pending' and completed_at is null from public.activities where id=test.value('activities_main')::uuid),'lead activities: new follow-up starts pending without completion timestamp');
select test.ok((select assigned_to=auth.uid() and created_by=auth.uid() and workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' from public.activities where id=test.value('activities_main')::uuid),'lead activities: server binds creator workspace lead and default assignee');
select test.ok((select created_at between now()-interval '1 minute' and now() and updated_at>=created_at from public.activities where id=test.value('activities_main')::uuid),'lead activities: creation and update timestamps come from server');
select test.ok((select due_at<now() from public.activities where id=test.value('activities_main')::uuid),'lead activities: pending task may retain a past due date for overdue display');
insert into test.context values('activities_created_at',(select created_at::text from public.activities where id=test.value('activities_main')::uuid));
select test.ok(public.save_activity(test.value('activities_ws_a')::uuid,'activities-own','Nova abordagem','whatsapp',now()+interval '3 days',auth.uid(),'Confirmar o próximo passo.',test.value('activities_main')::uuid)->>'id'=test.value('activities_main'),'lead activities: save edits existing activity without creating another id');
select test.ok((select title='Nova abordagem' and type='whatsapp' and description='Confirmar o próximo passo.' and due_at>now() from public.activities where id=test.value('activities_main')::uuid),'lead activities: closer edits content type description and schedule');
select test.ok((select created_at=test.value('activities_created_at')::timestamptz and created_by=auth.uid() and status='pending' from public.activities where id=test.value('activities_main')::uuid),'lead activities: edit preserves creator creation timestamp and status');
select test.denied(format('select public.save_activity(%L,''activities-own'','' '', ''follow_up'',now())',test.value('activities_ws_a')),'22023','lead activities: blank title is rejected');
select test.denied(format('select public.save_activity(%L,''activities-own'',null,''follow_up'',now())',test.value('activities_ws_a')),'22023','lead activities: null title is rejected');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Tipo indevido'',''automation'',now())',test.value('activities_ws_a')),'22023','lead activities: unknown activity type is rejected');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Sem horário'',''call'',null)',test.value('activities_ws_a')),'22023','lead activities: missing due timestamp is rejected');
select test.denied(format('select public.save_activity(%L,''activities-own'',repeat(''a'',181),''call'',now())',test.value('activities_ws_a')),'22023','lead activities: title longer than 180 characters is rejected');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Descrição excessiva'',''call'',now(),null,repeat(''a'',4001))',test.value('activities_ws_a')),'22023','lead activities: description longer than 4000 characters is rejected');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Prazo infinito'',''call'',''infinity'')',test.value('activities_ws_a')),'22023','lead activities: infinite task timestamp is rejected');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Delegação indevida'',''call'',now(),%L)',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000065'),'42501','lead activities: closer cannot assign own-lead task to another person');
select test.denied(format('select public.save_activity(%L,''activities-other'',''Lead de colega'',''call'',now())',test.value('activities_ws_a')),'42501','lead activities: closer cannot create task on a colleague lead');
select test.denied(format('select public.save_activity(%L,''activities-foreign'',''Outra empresa'',''call'',now())',test.value('activities_ws_b')),'42501','lead activities: closer cannot create task in another company');
select test.denied(format('insert into public.activities(workspace_id,lead_id,assigned_to,created_by,type,title,due_at) values(%L,''activities-own'',%L,%L,''call'',''Autoria falsa'',''1970-01-01'')',test.value('activities_ws_a'),auth.uid(),'00000000-0000-0000-0000-000000000060'),'42501','lead activities: direct insert cannot forge task creator or date');
select test.denied('update public.activities set created_by=''00000000-0000-0000-0000-000000000060'',created_at=''1970-01-01''','42501','lead activities: direct update cannot forge task creator or date');
select test.denied('delete from public.activities','42501','lead activities: direct task deletion cannot bypass scoped RPC');
select test.denied(format('insert into public.lead_events(workspace_id,lead_id,actor_id,event_type,metadata,created_at) values(%L,''activities-own'',%L,''lead.won'',''{}'',''1970-01-01'')',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000060'),'42501','lead activities: frontend cannot insert forged timeline actor event or timestamp');
select test.denied('update public.lead_events set actor_id=''00000000-0000-0000-0000-000000000060'',created_at=''1970-01-01''','42501','lead activities: frontend cannot overwrite timeline authorship');
select test.denied('delete from public.lead_events','42501','lead activities: frontend cannot erase commercial timeline directly');
insert into test.context values('activities_complete_own',public.save_activity(test.value('activities_ws_a')::uuid,'activities-own','Concluir atividade própria','follow_up',now())->>'id');
select test.ok(public.set_activity_status(test.value('activities_ws_a')::uuid,test.value('activities_complete_own')::uuid,'completed')->>'status'='completed','lead activities: closer completes own-lead task through RPC');
select test.ok((select completed_at between now()-interval '1 minute' and now() from public.activities where id=test.value('activities_complete_own')::uuid),'lead activities: completing activity uses server completion timestamp');
select test.denied(format('select public.set_activity_status(%L,%L,''pending'')',test.value('activities_ws_a'),test.value('activities_complete_own')),'22023','lead activities: completed activity cannot reopen through unsupported pending transition');
select test.denied(format('select public.set_activity_status(%L,%L,''cancelled'')',test.value('activities_ws_a'),test.value('activities_complete_own')),'23514','lead activities: completed activity cannot be changed to another final status');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Edição final indevida'',''follow_up'',now(),%L,'''',%L)',test.value('activities_ws_a'),auth.uid(),test.value('activities_complete_own')),'23514','lead activities: completed activity content is immutable');
select test.denied(format('select public.set_activity_status(%L,%L,''overdue'')',test.value('activities_ws_a'),test.value('activities_main')),'22023','lead activities: overdue is calculated rather than accepted as stored status');
insert into test.context values('activities_cancel_own',public.save_activity(test.value('activities_ws_a')::uuid,'activities-own','Cancelar atividade própria','other',now())->>'id');
select public.set_activity_status(test.value('activities_ws_a')::uuid,test.value('activities_cancel_own')::uuid,'cancelled');
select test.ok((select status='cancelled' and completed_at is null from public.activities where id=test.value('activities_cancel_own')::uuid),'lead activities: cancelled activity is retained without false completion timestamp');
select test.denied(format('select public.set_activity_status(%L,%L,''completed'')',test.value('activities_ws_a'),test.value('activities_cancel_own')),'23514','lead activities: cancelled activity cannot be changed to another final status');

-- Managers/admins manage the team, but assignment never enlarges lead permissions.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000061',false);
insert into test.context values('activities_other',public.save_activity(test.value('activities_ws_a')::uuid,'activities-other','Tarefa atribuída ao closer sem acesso','meeting',now()+interval '1 day','00000000-0000-0000-0000-000000000062')->>'id');
select test.ok((select assigned_to='00000000-0000-0000-0000-000000000062' and created_by=auth.uid() from public.activities where id=test.value('activities_other')::uuid),'lead activities: manager can assign team task to an active editable member');
select test.denied(format('select public.save_activity(%L,''activities-other'',''Assignee leitor'',''call'',now(),%L)',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000063'),'23514','lead activities: viewer cannot be assigned a task');
select test.denied(format('select public.save_activity(%L,''activities-other'',''Assignee inativo'',''call'',now(),%L)',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000066'),'23514','lead activities: inactive member cannot be assigned a task');
select test.denied(format('select public.save_activity(%L,''activities-other'',''Assignee estrangeiro'',''call'',now(),%L)',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000067'),'23514','lead activities: another company member cannot be assigned a task');
select test.ok(public.set_activity_status(test.value('activities_ws_a')::uuid,test.value('activities_other')::uuid,'completed')->>'status'='completed','lead activities: manager can complete team task');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
select test.ok(not exists(select 1 from public.activities where id=test.value('activities_other')::uuid),'lead activities: assignee alone cannot read task on inaccessible lead');
select test.ok(not exists(select 1 from public.lead_events where lead_id='activities-other' and workspace_id=test.value('activities_ws_a')::uuid),'lead activities: assignee alone cannot read inaccessible lead history');
select test.denied(format('select public.set_activity_status(%L,%L,''completed'')',test.value('activities_ws_a'),test.value('activities_other')),'42501','lead activities: assignee alone cannot complete inaccessible lead task');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000063',false);
select test.ok(exists(select 1 from public.activities where id=test.value('activities_main')::uuid) and exists(select 1 from public.activities where id=test.value('activities_other')::uuid),'lead activities: viewer can read allowed company activities');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Tarefa do leitor'',''email'',now())',test.value('activities_ws_a')),'42501','lead activities: viewer cannot create activity');
select test.denied(format('select public.set_activity_status(%L,%L,''completed'')',test.value('activities_ws_a'),test.value('activities_main')),'42501','lead activities: viewer cannot complete activity');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000064',false);
select test.ok(not exists(select 1 from public.activities where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: company B cannot read company A activities');
select test.ok(not exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: company B cannot read company A timeline');
insert into test.context values('activities_foreign',public.save_activity(test.value('activities_ws_b')::uuid,'activities-foreign','Tarefa empresa B','email',now()+interval '2 days','00000000-0000-0000-0000-000000000067')->>'id');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Tarefa cruzada'',''email'',now())',test.value('activities_ws_a')),'42501','lead activities: company B administrator cannot write into company A');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.ok(not exists(select 1 from public.activities where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: platform role alone cannot read customer activities');
select test.ok(not exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: platform role alone cannot read customer timeline');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Tarefa do operador'',''email'',now())',test.value('activities_ws_a')),'42501','lead activities: platform role alone cannot create customer activity');
select test.denied(format('select public.set_activity_status(%L,%L,''completed'')',test.value('activities_ws_a'),test.value('activities_main')),'42501','lead activities: platform role alone cannot complete customer activity');
reset role;

-- List only the authorized scope, with bounded pagination instead of loading every lead.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
insert into test.context values('activities_call_task',public.save_activity(test.value('activities_ws_a')::uuid,'activities-own','Call de retorno','call',now()+interval '1 day')->>'id');
insert into test.context values('activities_page_one',public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own',1,0)::text);
insert into test.context values('activities_page_two',public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own',1,1)::text);
select test.ok(jsonb_array_length(test.value('activities_page_one')::jsonb->'items')=1 and test.value('activities_page_one')::jsonb->>'next_offset'='1','lead activities: first activity page has a bounded item and continuation offset');
select test.ok(test.value('activities_page_one')::jsonb->'items'->0->>'id'<>test.value('activities_page_two')::jsonb->'items'->0->>'id','lead activities: consecutive activity pages do not duplicate a task');
select test.ok((public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own',1,3)->'next_offset')='null'::jsonb,'lead activities: final task page has no continuation');
select test.ok(jsonb_array_length(public.list_lead_activities(test.value('activities_ws_a')::uuid)->'items')=2,'lead activities: workspace task list limits closer to pending own-lead activities');
select test.ok(not exists(select 1 from jsonb_array_elements(public.list_lead_activities(test.value('activities_ws_a')::uuid)->'items') item where item->>'status'<>'pending'),'lead activities: operational workspace list excludes all completed and cancelled tasks');
select test.ok(exists(select 1 from jsonb_array_elements(public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where item->>'status'='completed') and exists(select 1 from jsonb_array_elements(public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where item->>'status'='cancelled'),'lead activities: lazy lead detail retains both completed and cancelled tasks');
select test.ok(not exists(select 1 from jsonb_array_elements(public.list_lead_activities(test.value('activities_ws_a')::uuid)->'items') item where item->>'lead_id'='activities-other'),'lead activities: workspace list excludes inaccessible task despite matching assignee');
select test.ok((select item->>'assigned_name'='Pessoa atividades 62' and item->>'created_by_name'='Pessoa atividades 62' from jsonb_array_elements(public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where item->>'id'=test.value('activities_main')),'lead activities: task DTO includes server-resolved assignee and creator names');
select test.denied(format('select public.list_lead_activities(%L,''activities-other'')',test.value('activities_ws_a')),'42501','lead activities: explicit colleague lead task list is denied');
select test.denied(format('select public.list_lead_activities(%L)',test.value('activities_ws_b')),'42501','lead activities: another company task list is denied');
select test.denied(format('select public.list_lead_events(%L,''activities-other'')',test.value('activities_ws_a')),'42501','lead activities: explicit inaccessible lead timeline is denied');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.created' and actor_id=auth.uid()),'lead activities: new lead automatically gets server-authored creation event');
select test.ok((select created_at between now()-interval '5 minutes' and now() from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.created'),'lead activities: creation timeline timestamp follows server time');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='activity.created' and actor_id=auth.uid()),'lead activities: task creation automatically enters commercial timeline');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='activity.updated'),'lead activities: task content update automatically enters timeline');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='activity.completed'),'lead activities: task completion automatically enters timeline');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='activity.cancelled'),'lead activities: task cancellation automatically enters timeline');
insert into test.context values('activities_event_count_before_same_status',(select count(*)::text from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own'));
insert into test.context values('activities_completion_stamp',(select completed_at::text from public.activities where id=test.value('activities_complete_own')::uuid));
select public.set_activity_status(test.value('activities_ws_a')::uuid,test.value('activities_complete_own')::uuid,'completed');
select test.ok((select count(*)=test.value('activities_event_count_before_same_status')::bigint from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own'),'lead activities: repeating completed status adds no noisy event');
select test.ok((select completed_at=test.value('activities_completion_stamp')::timestamptz from public.activities where id=test.value('activities_complete_own')::uuid),'lead activities: repeated completion preserves original completion timestamp');
insert into test.context values('activities_timeline_page_one',public.list_lead_events(test.value('activities_ws_a')::uuid,'activities-own',null,2)::text);
select test.ok(jsonb_array_length(test.value('activities_timeline_page_one')::jsonb->'items')=2 and test.value('activities_timeline_page_one')::jsonb->>'next_cursor' is not null,'lead activities: timeline first page is bounded with continuation cursor');
select test.ok(jsonb_typeof(test.value('activities_timeline_page_one')::jsonb->'items'->0->'id')='string','lead activities: timeline bigint IDs are serialized as strings');
insert into test.context values('activities_timeline_page_two',public.list_lead_events(test.value('activities_ws_a')::uuid,'activities-own',(test.value('activities_timeline_page_one')::jsonb->>'next_cursor')::bigint,2)::text);
select test.ok(not exists(select 1 from jsonb_array_elements(test.value('activities_timeline_page_one')::jsonb->'items') a join jsonb_array_elements(test.value('activities_timeline_page_two')::jsonb->'items') b on a->>'id'=b->>'id'),'lead activities: timeline continuation page does not repeat events');
select test.ok(not exists(select 1 from jsonb_array_elements(public.list_lead_events(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where item->>'event_type'='call.snapshot'),'lead activities: technical call snapshots are hidden from user-facing timeline');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
select test.denied(format('select public.save_activity(%L,''activities-other'',''Tentativa de mover tarefa'',''follow_up'',now(),%L,'''',%L)',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000060',test.value('activities_main')),'P0002','lead activities: an existing task cannot be moved to a different lead through edit');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Tarefa de outra empresa'',''follow_up'',now(),%L,'''',%L)',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000060',test.value('activities_foreign')),'P0002','lead activities: cross-company task identity cannot be edited in authorized workspace');
select test.denied(format('select public.set_activity_status(%L,%L,''completed'')',test.value('activities_ws_a'),test.value('activities_foreign')),'P0002','lead activities: cross-company task identity cannot be completed in authorized workspace');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000061',false);
select test.ok(jsonb_array_length(public.list_lead_activities(test.value('activities_ws_a')::uuid)->'items')=2,'lead activities: manager operational list excludes finalized team activities');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000063',false);
select test.ok(jsonb_array_length(public.list_lead_activities(test.value('activities_ws_a')::uuid)->'items')=2,'lead activities: viewer may read pending authorized operational tasks');
select test.ok(jsonb_array_length(public.list_lead_events(test.value('activities_ws_a')::uuid,'activities-own')->'items')>0,'lead activities: viewer may read commercial timeline within company');
reset role;

-- Lead updates create meaningful business history and preserve dated call versions.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
insert into test.context values('activities_before_cosmetic',(select count(*)::text from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own'));
update public.leads set data=data||'{"name":"Nome do lead corrigido"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok((select count(*)=test.value('activities_before_cosmetic')::bigint from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own'),'lead activities: cosmetic lead-name edit does not add technical timeline noise');
update public.leads set data=data||'{"ticket":22000}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.ticket_changed' and actor_id=auth.uid() and metadata->>'ticket'='22000'),'lead activities: direct authorized ticket update records server-authored financial event');
update public.leads set stage_id=(select id from public.pipeline_stages where workspace_id=test.value('activities_ws_a')::uuid and name='Qualificado') where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.stage_changed' and metadata->>'to_stage_name'='Qualificado'),'lead activities: authorized stage update records business stage transition');
update public.leads set data=data||'{"callDate":"2026-10-08T14:00:00.000Z","attendance":"Pendente","callScore":null,"callSummary":""}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='call.scheduled'),'lead activities: pending call schedule creates scheduled timeline event');
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'call_count'='1','lead activities: scheduled meeting is included in dated call count');
update public.leads set data=data||'{"attendance":"Compareceu","callScore":7,"callSummary":"Primeira call","objection":"Investimento","nextStep":"Enviar material"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='call.recorded' and actor_id=auth.uid()),'lead activities: attended meeting records call event automatically');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000061',false);
select public.review_call(test.value('activities_ws_a')::uuid,'activities-own','Aprofunde o diagnóstico antes da proposta',9);
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='call.reviewed' and actor_id=auth.uid() and metadata->'review'->>'reviewed_by'=auth.uid()::text),'lead activities: leadership review records actual reviewer on call date');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
update public.leads set data=data||'{"recordingUrl":"https://drive.example.test/first-recording","callScore":8,"callSummary":"Resumo aprofundado","closerError":"Apresentou proposta cedo","nextStep":"Validar decisão do sócio"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='call.recording_added' and metadata->>'recording_url'='https://drive.example.test/first-recording'),'lead activities: recording addition automatically enters commercial timeline');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='call.updated'),'lead activities: post-call fields automatically record a call update');
update public.leads set data=data||'{"callDate":"2026-10-10T14:00:00.000Z","attendance":"Pendente","callScore":null,"callSummary":"","recordingUrl":"","closerError":"","nextStep":"Reunião de retorno"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'call_count'='2','lead activities: changing meeting date preserves original call and adds second dated meeting');
update public.leads set data=data||'{"attendance":"Compareceu","callScore":6,"callSummary":"Segunda call","objection":"Timing"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
insert into test.context values('activities_call_history',public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')::text);
select test.ok(jsonb_array_length(test.value('activities_call_history')::jsonb->'items')=2,'lead activities: call history groups repeated updates into two dated meetings');
select test.ok((test.value('activities_call_history')::jsonb->'items'->0->>'call_date')::timestamptz='2026-10-10T14:00:00Z'::timestamptz,'lead activities: call history presents most recent meeting first');
select test.ok((select item->>'call_score'='8' and item->>'call_summary'='Resumo aprofundado' and item->>'recording_url'='https://drive.example.test/first-recording' and item->>'next_step'='Validar decisão do sócio' from jsonb_array_elements(test.value('activities_call_history')::jsonb->'items') item where (item->>'call_date')::timestamptz='2026-10-08T14:00:00Z'::timestamptz),'lead activities: previous dated call preserves latest score recording summary and next step');
select test.ok((select item->'leadership_review'->>'score'='9' and item->'leadership_review'->>'feedback'='Aprofunde o diagnóstico antes da proposta' and item->'leadership_review'->>'reviewed_by'='00000000-0000-0000-0000-000000000061' and item->'leadership_review'->>'reviewer_name'='Pessoa atividades 61' from jsonb_array_elements(test.value('activities_call_history')::jsonb->'items') item where (item->>'call_date')::timestamptz='2026-10-08T14:00:00Z'::timestamptz),'lead activities: original call retains its leadership review after a new meeting');
select test.ok((select item->'leadership_review'='null'::jsonb and item->>'call_score'='6' and item->>'call_summary'='Segunda call' from jsonb_array_elements(test.value('activities_call_history')::jsonb->'items') item where (item->>'call_date')::timestamptz='2026-10-10T14:00:00Z'::timestamptz),'lead activities: prior review is never incorrectly assigned to a new call date');
select test.ok(not exists(select 1 from jsonb_array_elements(test.value('activities_call_history')::jsonb->'items') item where (item->>'legacy')::boolean),'lead activities: new calls are not incorrectly marked as legacy imports');
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own',1,0)->>'next_offset'='1' and public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own',1,1)->'next_offset'='null'::jsonb,'lead activities: meeting history supports bounded offset pagination');
select test.denied(format('select public.list_lead_call_history(%L,''activities-other'')',test.value('activities_ws_a')),'42501','lead activities: closer cannot list a colleague call history');
update public.leads set data=data||'{"leadershipReview":{"score":10,"feedback":"Revisão falsa","reviewedBy":"00000000-0000-0000-0000-000000000062"}}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok((select item->'leadership_review'->>'score'='9' from jsonb_array_elements(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where (item->>'call_date')::timestamptz='2026-10-08T14:00:00Z'::timestamptz),'lead activities: forged lead JSON cannot replace stored historic leadership review');
update public.leads set stage_id=test.value('activities_won_stage')::uuid,data=data||'{"closedValue":22000}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.won' and metadata->>'closed_value'='22000'),'lead activities: won transition automatically records actual closed value');
update public.leads set stage_id=test.value('activities_lost_stage')::uuid,data=data||'{"lossReason":"Timing","lossComment":"Precisa aguardar"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.lost' and metadata->>'loss_reason'='Timing'),'lead activities: lost transition records actual loss reason');
update public.leads set data=data||'{"lossReason":"Investimento","lossComment":"Caixa indisponível"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.loss_reason_changed' and metadata->>'loss_reason'='Investimento'),'lead activities: subsequent loss reason update records a meaningful event');
update public.leads set stage_id=test.value('activities_normal_stage')::uuid where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.reopened'),'lead activities: reopening a closed opportunity records commercial event');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000063',false);
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'call_count'='2','lead activities: authorized viewer may inspect call history without editing');
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'owner_id'='00000000-0000-0000-0000-000000000062' and public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'owner_name'='Pessoa atividades 62','lead activities: viewer gets authorized lead owner identity for detail header');
select test.ok((public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'last_event_at')::timestamptz=(select max(created_at) from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type<>'call.snapshot'),'lead activities: detail summary last interaction comes from commercial timeline');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000064',false);
select test.denied(format('select public.list_lead_events(%L,''activities-own'')',test.value('activities_ws_a')),'42501','lead activities: company B cannot list company A commercial timeline');
select test.denied(format('select public.list_lead_call_history(%L,''activities-own'')',test.value('activities_ws_a')),'42501','lead activities: company B cannot list company A dated call history');
reset role;

-- Detail DTOs expose display names only, even when trusted fixtures have no name.
insert into test.context
select 'activities_names_before_'||p.id::text,jsonb_build_object('name',p.display_name,'alias',m.display_name)::text
from public.profiles p join public.memberships m on m.user_id=p.id and m.workspace_id=test.value('activities_ws_a')::uuid
where p.id in ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000062');
update public.profiles set display_name='' where id in ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000062');
update public.memberships set display_name=null where workspace_id=test.value('activities_ws_a')::uuid and user_id in ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000062');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000063',false);
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'owner_name'='Membro da equipe','lead activities: viewer owner summary never falls back to profile email when name is blank');
select test.ok((select item->>'assigned_name'='Membro da equipe' from jsonb_array_elements(public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where item->>'id'=test.value('activities_main')),'lead activities: viewer task assignee name never falls back to profile email');
select test.ok((select item->>'created_by_name'='Membro da equipe' from jsonb_array_elements(public.list_lead_activities(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where item->>'id'=test.value('activities_main')),'lead activities: viewer task creator name never falls back to profile email');
select test.ok(exists(select 1 from jsonb_array_elements(public.list_lead_events(test.value('activities_ws_a')::uuid,'activities-own',null,100)->'items') item where item->>'actor_id'='00000000-0000-0000-0000-000000000062') and not exists(select 1 from jsonb_array_elements(public.list_lead_events(test.value('activities_ws_a')::uuid,'activities-own',null,100)->'items') item where item->>'actor_id'='00000000-0000-0000-0000-000000000062' and item->>'actor_name' is distinct from 'Membro da equipe'),'lead activities: viewer timeline actor names are generic rather than email for nameless profiles');
select test.ok((select item->'leadership_review'->>'reviewer_name'='Membro da equipe' from jsonb_array_elements(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where (item->>'call_date')::timestamptz='2026-10-08T14:00:00Z'::timestamptz),'lead activities: viewer historic leadership reviewer name never falls back to email');
reset role;
update public.profiles p set display_name=c.value::jsonb->>'name' from test.context c
where c.key='activities_names_before_'||p.id::text and p.id in ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000062');
update public.memberships m set display_name=c.value::jsonb->>'alias' from test.context c
where c.key='activities_names_before_'||m.user_id::text and m.workspace_id=test.value('activities_ws_a')::uuid
  and m.user_id in ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000062');
select test.ok((select count(*)=2 and bool_and(p.display_name=c.value::jsonb->>'name' and m.display_name is not distinct from c.value::jsonb->>'alias') from public.profiles p join public.memberships m on m.user_id=p.id and m.workspace_id=test.value('activities_ws_a')::uuid join test.context c on c.key='activities_names_before_'||p.id::text where p.id in ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000062')),'lead activities: names-only regression restores both original global names and tenant aliases');

-- Equivalent timestamps and reviews without a real meeting must not corrupt history.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
set timezone='America/Sao_Paulo';
update public.leads set data=data||'{"callDate":"2026-10-10T11:00:00-03:00"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'call_count'='2','lead activities: same meeting with another UTC offset never creates a duplicate call');
set timezone='UTC';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000061',false);
select public.review_call(test.value('activities_ws_a')::uuid,'activities-admin','Revisão anterior a uma call real',9);
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-admin')->>'call_count'='0','lead activities: review without call data does not invent a historical meeting');
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-admin')->>'owner_name'='Pessoa atividades 60','lead activities: lead without a meeting still has authorized owner summary');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
update public.leads set data=data||'{"attendance":"Compareceu","callScore":8,"callSummary":"Reunião real sem data registrada"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-admin';
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-admin')->>'call_count'='1','lead activities: real undated meeting gets one call history item');
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-admin')->'items'->0->'leadership_review'='null'::jsonb,'lead activities: a review created before any call is not attached to later undated meeting');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000061',false);
select public.review_call(test.value('activities_ws_a')::uuid,'activities-admin','Feedback da reunião real sem data',7);
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-admin')->'items'->0->'leadership_review'->>'score'='7','lead activities: review of actual undated meeting is attached correctly');

-- Current lead ownership, rather than assignee, governs all detail/history reads.
update public.leads set owner_id='00000000-0000-0000-0000-000000000065' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own';
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-own' and event_type='lead.owner_changed' and actor_id=auth.uid() and metadata->>'to_owner_id'='00000000-0000-0000-0000-000000000065'),'lead activities: manager owner change records actual actor and destination owner');
select test.ok((select item->'metadata'->>'to_owner_name'='Pessoa atividades 65' from jsonb_array_elements(public.list_lead_events(test.value('activities_ws_a')::uuid,'activities-own')->'items') item where item->>'event_type'='lead.owner_changed'),'lead activities: owner-change DTO resolves destination member name on server');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
select test.ok(not exists(select 1 from public.activities where lead_id='activities-own' and workspace_id=test.value('activities_ws_a')::uuid),'lead activities: previous lead owner loses tasks even while remaining their assignee');
select test.ok(not exists(select 1 from public.lead_events where lead_id='activities-own' and workspace_id=test.value('activities_ws_a')::uuid),'lead activities: previous lead owner loses historical timeline after reassignment');
select test.denied(format('select public.list_lead_call_history(%L,''activities-own'')',test.value('activities_ws_a')),'42501','lead activities: previous owner cannot fetch lazy dated call history after reassignment');
select test.denied(format('select public.set_activity_status(%L,%L,''completed'')',test.value('activities_ws_a'),test.value('activities_main')),'42501','lead activities: previous owner cannot finish task after losing lead access');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
select public.update_member(test.value('activities_ws_a')::uuid,'00000000-0000-0000-0000-000000000062','closer',false);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000062',false);
select test.ok(not exists(select 1 from public.activities where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: deactivated member loses every activity read');
select test.ok(not exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: deactivated member loses every commercial history read');
select test.denied(format('select public.list_lead_activities(%L)',test.value('activities_ws_a')),'42501','lead activities: deactivated member cannot use operational task RPC');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000065',false);
select test.ok(public.list_lead_call_history(test.value('activities_ws_a')::uuid,'activities-own')->>'call_count'='2','lead activities: new active lead owner inherits authorized historical calls');
select test.ok(public.save_activity(test.value('activities_ws_a')::uuid,'activities-own','Atividade herdada com responsável inativo','email',now()+interval '1 day','00000000-0000-0000-0000-000000000062','Preservar a atribuição existente.',test.value('activities_main')::uuid)->>'assigned_to'='00000000-0000-0000-0000-000000000062','lead activities: closer may preserve previous inactive assignee while editing accessible task');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Reatribuição indevida'',''email'',now(),%L,'''',%L)',test.value('activities_ws_a'),'00000000-0000-0000-0000-000000000060',test.value('activities_main')),'42501','lead activities: closer still cannot newly assign accessible activity to someone else');
select test.ok(public.set_activity_status(test.value('activities_ws_a')::uuid,test.value('activities_main')::uuid,'completed')->>'status'='completed','lead activities: authorized new owner may complete task with deactivated assignee');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
select test.ok(public.save_activity(test.value('activities_ws_a')::uuid,'activities-own','Reatribuição administrativa','call',now()+interval '2 days',auth.uid(),'',test.value('activities_call_task')::uuid)->>'assigned_to'=auth.uid()::text,'lead activities: administrator may reassign pending team activity to active administrator');

-- Subscription suspension blocks detail reads/writes, while owner retains portability.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.admin_update_subscription(test.value('activities_ws_a')::uuid,'team','suspended',10);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000065',false);
select test.ok(not exists(select 1 from public.activities where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: suspended subscription blocks direct activity reads');
select test.ok(not exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: suspended subscription blocks direct commercial history reads');
select test.denied(format('select public.list_lead_activities(%L)',test.value('activities_ws_a')),'42501','lead activities: suspended subscription blocks operational task RPC');
select test.denied(format('select public.list_lead_events(%L,''activities-own'')',test.value('activities_ws_a')),'42501','lead activities: suspended subscription blocks lazy timeline RPC');
select test.denied(format('select public.list_lead_call_history(%L,''activities-own'')',test.value('activities_ws_a')),'42501','lead activities: suspended subscription blocks lazy call history RPC');
select test.denied(format('select public.save_activity(%L,''activities-own'',''Tarefa suspensa'',''call'',now())',test.value('activities_ws_a')),'42501','lead activities: suspended subscription blocks task save');
select test.denied(format('select public.set_activity_status(%L,%L,''completed'')',test.value('activities_ws_a'),test.value('activities_call_task')),'42501','lead activities: suspended subscription blocks task completion');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
insert into test.context values('activities_suspended_export',public.export_workspace(test.value('activities_ws_a')::uuid)::text);
select test.ok(test.value('activities_suspended_export')::jsonb ?& array['activities','lead_events','leads','call_reviews','pipelines','pipeline_stages','lead_privacy'],'lead activities: suspended administrator export includes all existing and new data sections');
select test.ok(jsonb_array_length(test.value('activities_suspended_export')::jsonb->'activities')=5,'lead activities: portability includes pending and finalized activity rows');
select test.ok(exists(select 1 from jsonb_array_elements(test.value('activities_suspended_export')::jsonb->'lead_events') item where item->>'event_type'='call.reviewed'),'lead activities: portability retains immutable call review events');
select test.ok(not exists(select 1 from jsonb_array_elements(test.value('activities_suspended_export')::jsonb->'lead_events') item where item->>'workspace_id'<>test.value('activities_ws_a')),'lead activities: new export history never includes another company');
select test.ok(jsonb_typeof(test.value('activities_suspended_export')::jsonb->'lead_events'->0->'id')='string','lead activities: export preserves bigint event IDs without JavaScript precision loss');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.denied(format('select public.export_workspace(%L)',test.value('activities_ws_a')),'42501','lead activities: platform role alone cannot export customer timeline and activities');
select public.admin_update_subscription(test.value('activities_ws_a')::uuid,'team','active',10);

-- Retention removes tasks and all personal history together with the expired lead.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
insert into test.context values('activities_purge_task',public.save_activity(test.value('activities_ws_a')::uuid,'activities-purge','Atividade de lead com retenção','follow_up',now(),'00000000-0000-0000-0000-000000000061')->>'id');
update public.leads set owner_id=auth.uid(),data=data||'{"callDate":"2026-10-09T12:00:00.000Z","attendance":"Compareceu","callScore":5,"callSummary":"Resumo sujeito à retenção"}' where workspace_id=test.value('activities_ws_a')::uuid and id='activities-purge';
select public.record_lead_privacy(test.value('activities_ws_a')::uuid,'activities-purge','contract',null,now()-interval '1 day');
select test.ok(public.purge_expired_leads(test.value('activities_ws_a')::uuid)=1,'lead activities: retention purge removes only one expired lead');
reset role;
select test.ok(not exists(select 1 from public.activities where id=test.value('activities_purge_task')::uuid),'lead activities: retention purge cascades expired lead tasks');
select test.ok(not exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid and lead_id='activities-purge'),'lead activities: retention purge cascades all dated snapshots and personal timeline');
select test.ok(exists(select 1 from public.activities where id=test.value('activities_foreign')::uuid),'lead activities: retention purge preserves other-company activities');
select test.ok(exists(select 1 from public.leads where workspace_id=test.value('activities_ws_a')::uuid and id='activities-own'),'lead activities: retention purge preserves active opportunity');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000060',false);
select public.delete_workspace(test.value('activities_ws_a')::uuid,'Empresa atividades A');
reset role;
select test.ok(not exists(select 1 from public.activities where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: workspace deletion cascades every activity');
select test.ok(not exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_a')::uuid),'lead activities: workspace deletion cascades every immutable event and call snapshot');
select test.ok(exists(select 1 from public.activities where id=test.value('activities_foreign')::uuid),'lead activities: workspace deletion preserves other-company task records');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('activities_ws_b')::uuid and lead_id='activities-foreign'),'lead activities: workspace deletion preserves other-company timeline');
-- A separate pending fixture is reserved for simultaneous completion/cancellation.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000064',false);
insert into test.context values('activities_status_race',public.save_activity(test.value('activities_ws_b')::uuid,'activities-foreign','Finalização concorrente','follow_up',now(),'00000000-0000-0000-0000-000000000067')->>'id');
reset role;
select 'Lead activities assertions passed: '||count(*) from test.results;
