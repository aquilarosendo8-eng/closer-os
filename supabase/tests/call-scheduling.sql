\set ON_ERROR_STOP on
-- Prove that the existing tenant-scoped lead write stores stage + appointment atomically.
-- These fixtures and helpers run only in scripts/test-database.sh's disposable PostgreSQL.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'scheduling-'||n||'@example.test',now(),jsonb_build_object('display_name','Pessoa agendamento '||n)
from generate_series(110,115) n;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('scheduling_ws_a',public.create_workspace('Agendamento empresa A')::text),('scheduling_ws_b',public.create_workspace('Agendamento empresa B')::text);
select public.admin_update_subscription(test.value('scheduling_ws_a')::uuid,'team','active',10);
select public.admin_update_subscription(test.value('scheduling_ws_b')::uuid,'team','active',10);
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('scheduling_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,true
from (values(110,'admin'),(111,'manager'),(112,'closer'),(113,'viewer')) s(n,member_role);
insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('scheduling_ws_b')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,true
from (values(114,'admin'),(115,'closer')) s(n,member_role);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000110' where id=test.value('scheduling_ws_a')::uuid;
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000114' where id=test.value('scheduling_ws_b')::uuid;
insert into test.context select 'scheduling_stage_a',id::text from public.pipeline_stages where workspace_id=test.value('scheduling_ws_a')::uuid and name='Call agendada';
insert into test.context select 'scheduling_stage_b',id::text from public.pipeline_stages where workspace_id=test.value('scheduling_ws_b')::uuid and name='Call agendada';
insert into test.context values('scheduling_time',to_char(clock_timestamp()+interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000112',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('scheduling_ws_a')::uuid,'scheduling-original',auth.uid(),
  test.lead('scheduling-original')||jsonb_build_object('callDate','2026-09-01T13:30:00.000Z','attendance','Compareceu','callScore',8,'callSummary','Histórico da call anterior'));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000115',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('scheduling_ws_b')::uuid,'scheduling-foreign',auth.uid(),test.lead('scheduling-foreign'));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000110',false);
select public.review_call(test.value('scheduling_ws_a')::uuid,'scheduling-original','Avaliação da reunião anterior',9);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000112',false);
insert into test.context values('scheduling_before',(select jsonb_build_object('stage_id',stage_id,'data',data)::text from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original'));
select test.denied(format('update public.leads set stage_id=%L,data=data||jsonb_build_object(''callDate'',''data inválida'',''attendance'',''Pendente'') where workspace_id=%L and id=''scheduling-original''',test.value('scheduling_stage_a'),test.value('scheduling_ws_a')),'23514','scheduling: invalid timestamp rejects entire stage and date update');
select test.ok((select jsonb_build_object('stage_id',stage_id,'data',data)=test.value('scheduling_before')::jsonb from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original'),'scheduling: failed save preserves previous stage attendance and call timestamp');
select test.denied(format('update public.leads set stage_id=%L,data=data||jsonb_build_object(''callDate'',%L,''attendance'',''Pendente'') where workspace_id=%L and id=''scheduling-original''',test.value('scheduling_stage_b'),test.value('scheduling_time'),test.value('scheduling_ws_a')),'23514','scheduling: foreign stage ID rejects stage and call update together');
select test.ok((select jsonb_build_object('stage_id',stage_id,'data',data)=test.value('scheduling_before')::jsonb from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original'),'scheduling: invalid tenant stage does not leave a new timestamp');
update public.leads set stage_id=test.value('scheduling_stage_a')::uuid,data=data||jsonb_build_object('callDate',test.value('scheduling_time'),'attendance','Pendente') where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original';
select test.ok((select stage_id=test.value('scheduling_stage_a')::uuid and data->>'callDate'=test.value('scheduling_time') and data->>'attendance'='Pendente' from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original'),'scheduling: owned lead persists the selected stage appointment and pending attendance in one update');
select test.ok((select count(*)=1 from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original'),'scheduling: appointment remains attached to exactly one original lead');
select test.ok((select data->>'callSummary'='Histórico da call anterior' and data->>'callScore'='8' from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original'),'scheduling: scheduling does not erase seller call facts');
select test.ok((select count(*)=1 from public.lead_events where workspace_id=test.value('scheduling_ws_a')::uuid and lead_id='scheduling-original' and event_type='call.scheduled'),'scheduling: one confirmation records exactly one scheduled timeline event');
select test.ok(exists(select 1 from jsonb_array_elements(public.list_lead_call_history(test.value('scheduling_ws_a')::uuid,'scheduling-original')->'items') item where (item->>'call_date')::timestamptz='2026-09-01T13:30:00.000Z'::timestamptz and item->>'attendance'='Compareceu' and item->>'call_summary'='Histórico da call anterior'),'scheduling: previous completed call remains in server history');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('scheduling_ws_a')::uuid and lead_id='scheduling-original' and event_type='call.reviewed' and (metadata->>'call_date')::timestamptz='2026-09-01T13:30:00.000Z'::timestamptz and metadata->'review'->>'score'='9'),'scheduling: prior leadership review retains its original call timestamp');
update public.leads set stage_id=test.value('scheduling_stage_a')::uuid,data=data||jsonb_build_object('callDate',test.value('scheduling_time'),'attendance','Pendente') where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original';
select test.ok((select count(*)=1 from public.lead_events where workspace_id=test.value('scheduling_ws_a')::uuid and lead_id='scheduling-original' and event_type='call.scheduled'),'scheduling: replaying identical appointment cannot duplicate scheduled history');
select test.ok(public.list_lead_call_history(test.value('scheduling_ws_a')::uuid,'scheduling-original')->>'call_count'='2','scheduling: history contains the old meeting and one new appointment');

-- Every role still passes the existing RLS, including direct tampered REST-style writes.
with changed as (update public.leads set data=data||jsonb_build_object('callDate',test.value('scheduling_time'),'attendance','Pendente') where workspace_id=test.value('scheduling_ws_b')::uuid and id='scheduling-foreign' returning id) select test.ok((select count(*) from changed)=0,'scheduling: closer cannot schedule a lead in another company');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000113',false);
with changed as (update public.leads set data=data||jsonb_build_object('callDate',test.value('scheduling_time')) where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original' returning id) select test.ok((select count(*) from changed)=0,'scheduling: viewer cannot schedule another member lead');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000114',false);
with changed as (update public.leads set data=data||jsonb_build_object('callDate',test.value('scheduling_time')) where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original' returning id) select test.ok((select count(*) from changed)=0,'scheduling: another company administrator cannot schedule this lead');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.ok(not exists(select 1 from public.memberships where workspace_id=test.value('scheduling_ws_a')::uuid and user_id=auth.uid()),'scheduling: Master has not received automatic company membership');
select test.ok((select count(*)=0 from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid),'scheduling: Master cannot read customer opportunities');
with changed as (update public.leads set data=data||jsonb_build_object('callDate',test.value('scheduling_time')) where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original' returning id) select test.ok((select count(*) from changed)=0,'scheduling: Master cannot schedule customer calls');
select test.denied(format('select public.list_lead_call_history(%L,''scheduling-original'')',test.value('scheduling_ws_a')),'42501','scheduling: Master cannot consult customer call history');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000111',false);
with changed as (update public.leads set data=data||jsonb_build_object('callDate',to_char(clock_timestamp()+interval '2 days','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attendance','Pendente') where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original' returning id) select test.ok((select count(*) from changed)=1,'scheduling: company manager can reschedule original lead');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000110',false);
with changed as (update public.leads set data=data||jsonb_build_object('callDate',to_char(clock_timestamp()+interval '3 days','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attendance','Pendente') where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original' returning id) select test.ok((select count(*) from changed)=1,'scheduling: company administrator can reschedule original lead');
select test.ok((select count(*)=1 from public.leads where workspace_id=test.value('scheduling_ws_a')::uuid and id='scheduling-original'),'scheduling: multiple reschedules never insert a duplicate lead');
reset role;
select 'Call scheduling assertions passed: ' || count(*) from test.results where label like 'scheduling:%';
