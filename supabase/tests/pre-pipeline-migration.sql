-- Only in a fresh disposable database: populate actual legacy rows before migration004.
create schema migration_test;
create table migration_test.results(label text primary key);
create function migration_test.ok(condition boolean,label text) returns void language plpgsql as $$ begin
  if condition is distinct from true then raise exception 'FAILED migration: %',label; end if;
  insert into migration_test.results values(label);
end; $$;
insert into auth.users(id,email,email_confirmed_at) values('00000000-0000-0000-0000-000000000030','backfill@example.test',now());
insert into public.workspaces(id,name,owner_id) values('10000000-0000-0000-0000-000000000030','Legacy backfill fixture','00000000-0000-0000-0000-000000000030');
insert into public.memberships(workspace_id,user_id,role) values('10000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000030','admin');
insert into public.workspace_settings(workspace_id) values('10000000-0000-0000-0000-000000000030');
insert into public.subscriptions(workspace_id,status) values('10000000-0000-0000-0000-000000000030','active');
insert into public.leads(workspace_id,id,owner_id,data)
select '10000000-0000-0000-0000-000000000030','backfill-'||s.n,'00000000-0000-0000-0000-000000000030',jsonb_build_object(
  'id','backfill-'||s.n,'name','Historical lead '||s.n,'company','Legacy business','email','historical@example.test','phone','Original phone',
  'source','Original source','createdAt','2026-09-01T12:00:00.000Z','lastContactAt','2026-09-04T12:00:00.000Z','callDate','',
  'notes','Historical note must remain unchanged','pain','Original pain','closerError','Original closer error','callSummary','Original call summary',
  'objection','Original objection','status',s.status,'attendance',case when s.status='Fechado' then 'Compareceu' else 'Pendente' end,
  'closedValue',case when s.status='Fechado' then 12345 else 0 end,'ticket',20000,'closedAt',case when s.status='Fechado' then '2026-09-03T12:00:00.000Z' else '' end,
  'urgency','Alta','financialCapacity','Média','decisionMaker',true,'callScore',8)
from (values(0,'Lead novo'),(1,'Qualificado'),(2,'Call agendada'),(3,'Compareceu'),(4,'Follow-up'),(5,'Fechado'),(6,'Perdido')) s(n,status);
create table migration_test.original_leads as select * from public.leads where workspace_id='10000000-0000-0000-0000-000000000030';
