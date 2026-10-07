-- Assert the upgrade itself before removing fixtures, leaving previous regression suites unchanged.
select migration_test.ok((select count(*)=7 from public.leads where workspace_id='10000000-0000-0000-0000-000000000030'),'migration preserves all seven legacy leads');
select migration_test.ok((select count(*)=1 from public.pipelines where workspace_id='10000000-0000-0000-0000-000000000030' and is_default),'migration creates one default pipeline');
select migration_test.ok((select count(*)=7 from public.pipeline_stages where workspace_id='10000000-0000-0000-0000-000000000030'),'migration creates seven default stages');
select migration_test.ok(not exists(select 1 from migration_test.original_leads o join public.leads l using(workspace_id,id) where l.data-'stageId'-'stageName'-'stageType'<>o.data),'migration preserves every original JSON business field');
select migration_test.ok(not exists(select 1 from migration_test.original_leads o join public.leads l using(workspace_id,id) where l.owner_id<>o.owner_id or l.created_at<>o.created_at or l.updated_at<>o.updated_at or l.created_by is distinct from o.created_by or l.updated_by is distinct from o.updated_by),'migration preserves owner authorship and timestamps');
select migration_test.ok(not exists(select 1 from migration_test.original_leads o join public.leads l using(workspace_id,id) where l.retention_until is distinct from o.retention_until or l.lawful_basis is distinct from o.lawful_basis or l.consent_at is distinct from o.consent_at),'migration preserves all privacy metadata');
select migration_test.ok(not exists(select 1 from public.leads l join public.pipeline_stages s on s.workspace_id=l.workspace_id and s.id=l.stage_id where l.workspace_id='10000000-0000-0000-0000-000000000030' and (s.legacy_status<>l.data->>'status' or l.data->>'stageId'<>s.id::text or l.data->>'stageName'<>s.name or l.data->>'stageType'<>s.type)),'migration maps every legacy status to the correct stage');
select migration_test.ok((select s.type='WON' and l.data->>'closedValue'='12345' from public.leads l join public.pipeline_stages s on s.id=l.stage_id where l.id='backfill-5'),'migration preserves won revenue and type');
select migration_test.ok((select s.type='LOST' and l.loss_reason_grandfathered and not(l.data ? 'lossReason') from public.leads l join public.pipeline_stages s on s.id=l.stage_id where l.id='backfill-6'),'migration preserves historical lost leads without inventing a loss reason');
select migration_test.ok((select count(*)=7 from public.audit_logs where workspace_id='10000000-0000-0000-0000-000000000030' and action='lead.insert'),'migration does not manufacture new lead audit events');
-- Edits to an already LOST historical lead remain valid, without requiring a fabricated reason.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000030',false);
update public.leads set data=jsonb_set(data,'{nextStep}','"Historical follow-up"') where id='backfill-6';
reset role;
select migration_test.ok((select data->>'nextStep'='Historical follow-up' and not(data ? 'lossReason') from public.leads where id='backfill-6'),'migrated old lost lead can be edited without a loss reason');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000030',false);
update public.leads set data=data||'{"lossReason":"Sumiu"}' where id='backfill-6';
do $$ declare denied boolean:=false;
begin
  begin update public.leads set data=jsonb_set(data,'{lossReason}','""') where id='backfill-6';
  exception when check_violation then denied:=true; end;
  if not denied then raise exception 'FAILED migration: historical loss exemption must be consumed once reason is recorded'; end if;
end; $$;
reset role;
select migration_test.ok((select not loss_reason_grandfathered and data->>'lossReason'='Sumiu' from public.leads where id='backfill-6'),'historical loss exemption is consumed once a reason is recorded and cannot be restored');

delete from public.workspaces where id='10000000-0000-0000-0000-000000000030';
delete from auth.users where id='00000000-0000-0000-0000-000000000030';
select migration_test.ok(not exists(select 1 from public.pipeline_stages where workspace_id='10000000-0000-0000-0000-000000000030'),'workspace deletion cascades migrated stage configuration');
