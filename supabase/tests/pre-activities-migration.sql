-- Only in the fresh local harness: real legacy rows before migration006.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(
  '00000000-0000-0000-0000-000000000080','activities-backfill@example.test',now(),
  '{"display_name":"Titular legado de atividades","full_name":"Nome completo preservado","terms_version":"2026-10-06","preferences":{"theme":"dark"}}'
);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
insert into public.workspaces(id,name,owner_id,privacy_contact_email,retention_days) values(
  '10000000-0000-0000-0000-000000000080','Legacy activities fixture','00000000-0000-0000-0000-000000000080','privacy-legacy@example.test',730
);
insert into public.memberships(workspace_id,user_id,role,display_name) values(
  '10000000-0000-0000-0000-000000000080','00000000-0000-0000-0000-000000000080','admin','Nome local legado'
);
insert into public.workspace_settings(workspace_id,name,commission_rate,revenue_goal) values(
  '10000000-0000-0000-0000-000000000080','Apresentação legada',13.75,345678
);
insert into public.subscriptions(workspace_id,plan,status,seat_limit,current_period_end) values(
  '10000000-0000-0000-0000-000000000080','team','active',7,'2030-01-01T00:00:00Z'
);
insert into public.leads(workspace_id,id,owner_id,data)
select '10000000-0000-0000-0000-000000000080','activities-backfill-'||n,'00000000-0000-0000-0000-000000000080',jsonb_build_object(
  'id','activities-backfill-'||n,'name','Contato histórico '||n,'company','Empresa histórica','email','legacy-lead@example.test','phone','Telefone original',
  'source','Origem legada','createdAt','2001-02-03T12:00:00.000Z','lastContactAt','2026-09-12T12:00:00.000Z',
  'callDate',case when n=1 then '2026-09-12T09:00:00-03:00' else '' end,'notes','Observação legada preservada',
  'pain','Dor original','closerError','Erro original','callSummary',case when n=1 then 'Resumo da única call conhecida' else '' end,
  'objection','Investimento','status',case when n=1 then 'Compareceu' else 'Lead novo' end,
  'attendance',case when n=1 then 'Compareceu' else 'Pendente' end,'ticket',27000,'closedValue',0,'closedAt','',
  'urgency','Alta','financialCapacity','Média','decisionMaker',true,'callScore',case when n=1 then 8 else null end,
  'recordingUrl',case when n=1 then 'https://recordings.example.test/legacy-call' else '' end,'nextStep','Próximo passo legado'
)
from generate_series(1,2) n;
-- Give persisted metadata distinct historical values without runtime trigger rewrites.
alter table public.leads disable trigger lead_prepare;
alter table public.leads disable trigger lead_audit;
update public.leads set created_at='2002-03-04T12:00:00Z',updated_at='2026-09-13T12:00:00Z',
  created_by=case when id='activities-backfill-1' then '00000000-0000-0000-0000-000000000080'::uuid else null end,
  updated_by='00000000-0000-0000-0000-000000000080',lawful_basis='consent',consent_at='2026-09-01T12:00:00Z',retention_until='2028-09-01T12:00:00Z'
where workspace_id='10000000-0000-0000-0000-000000000080';
alter table public.leads enable trigger lead_prepare;
alter table public.leads enable trigger lead_audit;
insert into public.call_reviews(workspace_id,lead_id,feedback,score,reviewed_by,reviewed_at) values(
  '10000000-0000-0000-0000-000000000080','activities-backfill-1','Feedback legado preservado',9,'00000000-0000-0000-0000-000000000080','2026-09-13T10:00:00Z'
);
create table migration_test.activities_original_leads as select * from public.leads where workspace_id='10000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_workspaces as select * from public.workspaces where id='10000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_settings as select * from public.workspace_settings where workspace_id='10000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_memberships as select * from public.memberships where workspace_id='10000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_subscriptions as select * from public.subscriptions where workspace_id='10000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_profiles as select * from public.profiles where id='00000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_auth as select * from auth.users where id='00000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_reviews as select * from public.call_reviews where workspace_id='10000000-0000-0000-0000-000000000080';
create table migration_test.activities_original_audit as select * from public.audit_logs where workspace_id='10000000-0000-0000-0000-000000000080';
create table migration_test.activities_migration_started as select clock_timestamp() as started_at;
select set_config('request.jwt.claim.sub','',false);
