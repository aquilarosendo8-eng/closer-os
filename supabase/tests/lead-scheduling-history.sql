\set ON_ERROR_STOP on
-- Real PostgreSQL authorization and whole-JSON writes in a disposable database.
insert into auth.users(id,email,email_confirmed_at)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'booking-history-'||n||'@example.test',now()
from generate_series(190,195) n;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('booking_ws_a',public.create_workspace('Agendamento empresa A')::text),('booking_ws_b',public.create_workspace('Agendamento empresa B')::text);
select public.admin_update_subscription(test.value('booking_ws_a')::uuid,'team','active',10);
select public.admin_update_subscription(test.value('booking_ws_b')::uuid,'team','active',10);
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('booking_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,true
from (values(190,'admin'),(191,'manager'),(192,'closer'),(193,'sdr'),(194,'viewer')) s(n,member_role);
insert into public.memberships(workspace_id,user_id,role,is_active)
values(test.value('booking_ws_b')::uuid,'00000000-0000-0000-0000-000000000195','admin',true);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000190' where id=test.value('booking_ws_a')::uuid;
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000195' where id=test.value('booking_ws_b')::uuid;
insert into test.context select 'booking_'||type,id::text from public.pipeline_stages where workspace_id=test.value('booking_ws_a')::uuid and type in ('WON','LOST');
insert into test.context select 'booking_call_stage',id::text from public.pipeline_stages where workspace_id=test.value('booking_ws_a')::uuid and name='Call agendada';
insert into test.context select 'booking_follow_stage',id::text from public.pipeline_stages where workspace_id=test.value('booking_ws_a')::uuid and name='Follow-up';

select test.ok(exists(select 1 from pg_trigger where tgrelid='public.leads'::regclass and tgname='lead_scheduling_history' and tgenabled='O' and not tgisinternal),'booking: all lead writes retain history through enabled trigger');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in ('public','private') and a.grantee=0 and a.privilege_type='EXECUTE'),'booking: no implicit PUBLIC function execution');
select test.ok(not has_function_privilege('authenticated','private.valid_scheduling_timestamp(jsonb)','EXECUTE'),'booking: timestamp helper stays private');
select test.ok(not has_function_privilege('anon','private.preserve_lead_scheduling_history()','EXECUTE'),'booking: anonymous cannot execute trigger function');
select test.ok(not has_function_privilege('authenticated','private.preserve_lead_scheduling_history()','EXECUTE'),'booking: authenticated cannot call trigger function directly');
select test.ok(has_function_privilege('authenticated','public.import_leads(uuid,jsonb,uuid)','EXECUTE') and has_function_privilege('service_role','public.import_leads(uuid,jsonb,uuid)','EXECUTE'),'booking: legacy JSON importer keeps authenticated and service ACLs');
select test.ok((select prosecdef and 'search_path=""'=any(proconfig) from pg_proc where oid='private.preserve_lead_scheduling_history()'::regprocedure),'booking: trigger definer locks empty search path');
select test.ok((select relrowsecurity from pg_class where oid='public.leads'::regclass),'booking: existing leads RLS remains enabled');

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000192',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('booking_ws_a')::uuid,'booking-own',auth.uid(),test.lead('booking-own'));
insert into test.context select 'booking_stale_json',data::text from public.leads where id='booking-own';
select test.ok((select not(data ? 'firstScheduledAt') and not(data ? 'hasBeenScheduled') from public.leads where id='booking-own'),'booking: received lead has no invented booking evidence');
update public.leads set stage_id=test.value('booking_call_stage')::uuid where id='booking-own';
select test.ok((select not(data ? 'firstScheduledAt') and not(data ? 'hasBeenScheduled') from public.leads where id='booking-own'),'booking: stage label alone does not prove a booked call');
update public.leads set data=data||'{"callDate":"2026-11-12T15:30:00.000Z","firstScheduledAt":"2001-01-01T00:00:00.000Z","hasBeenScheduled":true}' where id='booking-own';
insert into test.context select 'booking_first',data->>'firstScheduledAt' from public.leads where id='booking-own';
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and abs(extract(epoch from clock_timestamp()-(data->>'firstScheduledAt')::timestamptz))<5 from public.leads where id='booking-own'),'booking: first direct REST style scheduling records server time');
select test.ok(test.value('booking_first')<>'2001-01-01T00:00:00.000Z','booking: client cannot backdate the first genuine scheduling instant');
select test.ok((select data->>'callDate'='2026-11-12T15:30:00.000Z' and data->>'attendance'='Pendente' from public.leads where id='booking-own'),'booking: server history does not change selected appointment or attendance');
select test.ok((select data->>'createdAt'='2026-10-07T12:00:00.000Z' from public.leads where id='booking-own'),'booking: scheduling never shifts lead received cohort');
update public.leads set data=data||'{"callDate":"2026-11-13T15:30:00.000Z"}' where id='booking-own';
update public.leads set data=data||'{"callDate":"2026-11-14T15:30:00.000Z","firstScheduledAt":"2090-01-01T00:00:00.000Z","hasBeenScheduled":false}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') and data->'hasBeenScheduled'='true'::jsonb from public.leads where id='booking-own'),'booking: repeated rescheduling preserves original booking once');
update public.leads set data=(data-'firstScheduledAt'-'hasBeenScheduled')||'{"attendance":"Compareceu"}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') and data->'hasBeenScheduled'='true'::jsonb and data->>'attendance'='Compareceu' from public.leads where id='booking-own'),'booking: attended call retains first booking');
update public.leads set data=(data-'firstScheduledAt'-'hasBeenScheduled')||'{"attendance":"Não compareceu"}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') and data->>'attendance'='Não compareceu' from public.leads where id='booking-own'),'booking: no-show retains first booking');
update public.leads set stage_id=test.value('booking_follow_stage')::uuid,data=data||'{"callDate":""}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') and data->'hasBeenScheduled'='true'::jsonb from public.leads where id='booking-own'),'booking: follow-up and cleared call retain booking evidence');
update public.leads set data=test.value('booking_stale_json')::jsonb||'{"notes":"Stale whole-document edit"}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') and data->'hasBeenScheduled'='true'::jsonb and data->>'notes'='Stale whole-document edit' from public.leads where id='booking-own'),'booking: stale full JSON replacement cannot erase previous booking');
update public.leads set stage_id=test.value('booking_WON')::uuid,data=data||'{"closedValue":18000}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') and data->>'attendance'='Compareceu' and data->>'closedValue'='18000' from public.leads where id='booking-own'),'booking: won transition preserves first booking and existing won semantics');
update public.leads set stage_id=test.value('booking_LOST')::uuid,data=data||'{"lossReason":"Timing"}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') and data->'hasBeenScheduled'='true'::jsonb from public.leads where id='booking-own'),'booking: lost transition does not erase historical conversion');

-- Imported dates prove booking but do not reveal when the appointment was made.
select test.ok(public.import_leads(test.value('booking_ws_a')::uuid,jsonb_build_array(
  test.lead('booking-json-legacy')||'{"callDate":"2024-04-05T15:30:00.000Z","createdAt":"2024-03-01T12:00:00.000Z"}',
  test.lead('booking-json-known')||'{"callDate":"","firstScheduledAt":"2024-03-02T10:00:00.000Z","hasBeenScheduled":true}',
  test.lead('booking-json-proof')||'{"callDate":"","hasBeenScheduled":true}',
  test.lead('booking-json-empty')))->>'imported'='4','booking: existing JSON restore accepts old and new backup fields');
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and not(data ? 'firstScheduledAt') from public.leads where id='booking-json-legacy'),'booking: legacy JSON callDate evidence never gets a fabricated first instant');
select test.ok((select data->>'firstScheduledAt'='2024-03-02T10:00:00.000Z' from public.leads where id='booking-json-known'),'booking: JSON restore preserves a known historical booking instant');
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and not(data ? 'firstScheduledAt') from public.leads where id='booking-json-proof'),'booking: JSON restore preserves evidence with unknown instant and cleared date');
select test.ok((select not(data ? 'firstScheduledAt') and not(data ? 'hasBeenScheduled') from public.leads where id='booking-json-empty'),'booking: unscheduled JSON restore stays unscheduled');
select test.ok(coalesce(current_setting('closer_os.historical_lead_import',true),'')='','booking: JSON success restores prior transaction-local import context');
update public.leads set data=(data-'hasBeenScheduled')||'{"callDate":""}' where id='booking-json-legacy';
update public.leads set data=data||'{"callDate":"2026-12-01T10:00:00.000Z"}' where id='booking-json-legacy';
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and not(data ? 'firstScheduledAt') and data->>'createdAt'='2024-03-01T12:00:00.000Z' from public.leads where id='booking-json-legacy'),'booking: imported unknown first stays unknown after clearing and rescheduling');
select test.ok(public.import_leads(test.value('booking_ws_a')::uuid,jsonb_build_array(test.lead('booking-json-known')||'{"firstScheduledAt":"2090-01-01T00:00:00Z"}'))->>'skipped'='1','booking: duplicate JSON restore remains insert-only');
select test.ok((select data->>'firstScheduledAt'='2024-03-02T10:00:00.000Z' from public.leads where id='booking-json-known'),'booking: duplicate restore cannot overwrite known historical evidence');
select set_config('closer_os.historical_lead_import','prior-context',false);
select public.import_leads(test.value('booking_ws_a')::uuid,'[]');
select test.ok(current_setting('closer_os.historical_lead_import',true)='prior-context','booking: JSON restore retains a caller previous non-authentication context');
select test.denied(format('select public.import_leads(%L,%L::jsonb)',test.value('booking_ws_a'),jsonb_build_array(test.lead('booking-rollback-first')||'{"callDate":"2024-01-01T15:00:00Z"}',test.lead('booking-rollback-bad')||'{"firstScheduledAt":"invalid"}')),'23514','booking: invalid optional history rejects and rolls back entire JSON batch');
select test.ok(not exists(select 1 from public.leads where id in ('booking-rollback-first','booking-rollback-bad')),'booking: failed historical restore leaves no partial rows');
select test.ok(current_setting('closer_os.historical_lead_import',true)='prior-context','booking: JSON failure restores previous context');
select set_config('closer_os.historical_lead_import','',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('booking_ws_a')::uuid,'booking-after-import',auth.uid(),test.lead('booking-after-import')||'{"callDate":"2026-11-01T10:00:00Z"}');
select test.ok((select private.valid_lead_data(data) and data ? 'firstScheduledAt' from public.leads where id='booking-after-import'),'booking: genuine manual insert after import still gets first scheduling time');

do $$ declare changes jsonb; item_label text; begin
  for changes,item_label in select * from (values
    ('{"firstScheduledAt":null}'::jsonb,'null timestamp'),('{"firstScheduledAt":false}'::jsonb,'boolean timestamp'),
    ('{"firstScheduledAt":""}'::jsonb,'empty timestamp'),('{"firstScheduledAt":"infinity"}'::jsonb,'infinite timestamp'),
    ('{"firstScheduledAt":"2026-13-45T12:00:00Z"}'::jsonb,'invalid calendar timestamp'),
    ('{"hasBeenScheduled":"true"}'::jsonb,'string marker'),('{"hasBeenScheduled":1}'::jsonb,'number marker'),('{"hasBeenScheduled":null}'::jsonb,'null marker')) x(changes,item_label) loop
    perform test.denied(format('update public.leads set data=data||%L::jsonb where id=''booking-own''',changes),'23514','booking: server rejects '||item_label);
  end loop;
end; $$;

-- Legacy rows that predate the migration are not backfilled or rewritten.
reset role;
alter table public.leads disable trigger lead_scheduling_history;
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('booking_ws_a')::uuid,'booking-pre-migration','00000000-0000-0000-0000-000000000192',test.lead('booking-pre-migration')||'{"callDate":"2023-01-02T10:00:00Z"}');
alter table public.leads enable trigger lead_scheduling_history;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000192',false);
select test.ok((select not(data ? 'firstScheduledAt') and not(data ? 'hasBeenScheduled') from public.leads where id='booking-pre-migration'),'booking: old stored call evidence is read without a backfill');
update public.leads set data=data||'{"callDate":"","notes":"First post-upgrade save"}' where id='booking-pre-migration';
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and not(data ? 'firstScheduledAt') from public.leads where id='booking-pre-migration'),'booking: clearing old call on first new save retains proof without fabricating time');

-- CSV/XLSX use the same server RPC, with provenance already supplied by SQL.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000140',false);
select test.ok(test.external_import(jsonb_build_array(test.external_record('booking-csv-history',1,'{"callDate":"2024-05-06T11:30:00Z","createdAt":"2024-04-01T12:00:00Z","email":"booking-csv-history@example.test"}')))->>'imported'='1','booking: existing CSV XLSX import accepts scheduled historic row');
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and not(data ? 'firstScheduledAt') and data->>'createdAt'='2024-04-01T12:00:00Z' from public.leads where workspace_id=test.value('external_ws_a')::uuid and data->>'email'='booking-csv-history@example.test'),'booking: CSV XLSX history counts once without fabricated first time or shifted cohort');
update public.leads set data=(data-'hasBeenScheduled')||'{"callDate":""}' where workspace_id=test.value('external_ws_a')::uuid and data->>'email'='booking-csv-history@example.test';
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and not(data ? 'firstScheduledAt') from public.leads where workspace_id=test.value('external_ws_a')::uuid and data->>'email'='booking-csv-history@example.test'),'booking: later edits preserve CSV XLSX evidence after clearing date');

-- Access rules are unchanged: own leads only for Closer/SDR, no Master bypass.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000193',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('booking_ws_a')::uuid,'booking-sdr',auth.uid(),test.lead('booking-sdr'));
update public.leads set data=data||'{"callDate":"2026-11-03T10:00:00Z"}' where id='booking-sdr';
select test.ok((select data->'hasBeenScheduled'='true'::jsonb and data ? 'firstScheduledAt' from public.leads where id='booking-sdr'),'booking: SDR own lead uses same first scheduling contract');
select test.ok(not exists(select 1 from public.leads where id='booking-own'),'booking: SDR cannot read another sellers scheduling metrics');
with changed as(update public.leads set data=data||'{"callDate":"2026-11-03T11:00:00Z"}' where id='booking-own' returning id)
select test.ok((select count(*)=0 from changed),'booking: SDR cannot schedule another sellers lead');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000192',false);
select test.ok(not exists(select 1 from public.leads where id='booking-sdr'),'booking: Closer cannot read SDR lead scheduling data');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000194',false);
with changed as(update public.leads set data=data||'{"callDate":"2026-11-03T11:00:00Z"}' where id='booking-own' returning id)
select test.ok((select count(*)=0 from changed),'booking: Viewer scheduling write remains blocked');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000195',false);
select test.ok(not exists(select 1 from public.leads where workspace_id=test.value('booking_ws_a')::uuid),'booking: foreign company cannot read booking cohort');
with changed as(update public.leads set data=data||'{"callDate":"2026-11-03T11:00:00Z"}' where id='booking-own' returning id)
select test.ok((select count(*)=0 from changed),'booking: foreign administrator cannot alter booking history');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.ok(not exists(select 1 from public.leads where workspace_id=test.value('booking_ws_a')::uuid),'booking: Master without membership cannot read customer scheduling data');
with changed as(update public.leads set data=data||'{"callDate":"2026-11-03T11:00:00Z"}' where id='booking-own' returning id)
select test.ok((select count(*)=0 from changed),'booking: Master without membership cannot alter scheduling history');
select test.denied(format('select public.export_workspace(%L)',test.value('booking_ws_a')),'42501','booking: Master commercial export remains blocked');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000191',false);
update public.leads set data=(data-'firstScheduledAt'-'hasBeenScheduled')||'{"notes":"Manager authorized edit"}' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') from public.leads where id='booking-own'),'booking: manager edits preserve first history without new grants');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000190',false);
update public.leads set owner_id='00000000-0000-0000-0000-000000000193' where id='booking-own';
select test.ok((select data->>'firstScheduledAt'=test.value('booking_first') from public.leads where id='booking-own'),'booking: existing administrator reassignment preserves first history');

-- Fixtures used by a deterministic two-writer stale-document race in the harness.
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('booking_ws_a')::uuid,'booking-race','00000000-0000-0000-0000-000000000192',test.lead('booking-race'));
insert into test.context select 'booking_race_stale',data::text from public.leads where workspace_id=test.value('booking_ws_a')::uuid and id='booking-race';
reset role;
set role anon;
select test.denied('select * from public.leads','42501','booking: anonymous cannot read booking data');
select test.denied(format('select public.import_leads(%L,''[]'')',test.value('booking_ws_a')),'42501','booking: anonymous legacy JSON import stays blocked');
reset role;
select 'Lead scheduling history assertions passed: '||count(*) from test.results where label like 'booking:%';
