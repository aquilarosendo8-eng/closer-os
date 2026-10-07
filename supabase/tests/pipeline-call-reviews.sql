\set ON_ERROR_STOP on
-- Real roles/RLS, configurable stages, recordings and independent leadership reviews.
insert into auth.users(id,email,email_confirmed_at) select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'pipeline'||n||'@example.test',now() from generate_series(31,35) n;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('pipeline_ws',public.create_workspace('Pipeline configurável')::text);
select public.admin_update_subscription(test.value('pipeline_ws')::uuid,'team','active',4);
select test.denied(format('select public.list_pipeline_stages(%L)',test.value('pipeline_ws')),'42501','platform operator does not gain customer pipeline access');
select test.denied(format('select public.save_pipeline_stages(%L,''[]''::jsonb)',test.value('pipeline_ws')),'42501','platform operator cannot configure customer pipeline');
reset role;
insert into public.memberships(workspace_id,user_id,role) select test.value('pipeline_ws')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,role from(values(31,'admin'),(32,'manager'),(33,'closer'),(34,'viewer'))s(n,role);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000031' where id=test.value('pipeline_ws')::uuid;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000031',false);
select test.ok(jsonb_array_length(public.list_pipeline_stages(test.value('pipeline_ws')::uuid))=7,'future workspace automatically receives seven stages');
insert into test.context values('pipeline_config',public.list_pipeline_stages(test.value('pipeline_ws')::uuid)::text);
select test.ok((select count(*)=1 from public.pipelines where workspace_id=test.value('pipeline_ws')::uuid and is_default),'future workspace has one default pipeline');
insert into test.context values('custom_stage',(select entry->>'id' from jsonb_array_elements(public.save_pipeline_stages(test.value('pipeline_ws')::uuid,test.value('pipeline_config')::jsonb||'[{"name":"Proposta","color":"#8b5cf6","type":"NORMAL","active":true}]'::jsonb)) entry where entry->>'name'='Proposta'));
select test.ok((select name='Proposta' and type='NORMAL' and position=7 from public.pipeline_stages where id=test.value('custom_stage')::uuid),'admin creates generated custom stage');
update test.context set value=public.list_pipeline_stages(test.value('pipeline_ws')::uuid)::text where key='pipeline_config';
insert into test.context values('normal_stage',(select entry->>'id' from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry where entry->>'name'='Lead novo')),
 ('won_stage',(select entry->>'id' from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry where entry->>'type'='WON')),
 ('lost_stage',(select entry->>'id' from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry where entry->>'type'='LOST'));
select test.denied('update public.pipeline_stages set name=''Forged''','42501','direct stage configuration bypass is denied');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000032',false);
select public.save_pipeline_stages(test.value('pipeline_ws')::uuid,(select jsonb_agg(entry order by (entry->>'id'=test.value('custom_stage')) desc,(entry->>'position')::integer) from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry));
select test.ok((select position=0 from public.pipeline_stages where id=test.value('custom_stage')::uuid),'manager reorders stages by array order');
update test.context set value=public.list_pipeline_stages(test.value('pipeline_ws')::uuid)::text where key='pipeline_config';
select test.denied(format('select public.save_pipeline_stages(%L,%L::jsonb)',test.value('pipeline_ws'),(select jsonb_agg(case when entry->>'type'='WON' then jsonb_set(entry,'{active}','false') else entry end) from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry)),'23514','pipeline requires one active won stage');
select test.denied(format('select public.save_pipeline_stages(%L,%L::jsonb)',test.value('pipeline_ws'),test.value('pipeline_config')::jsonb||'[{"name":"Outro ganho","color":"#10b981","type":"WON","active":true}]'::jsonb),'23514','pipeline cannot have two active won stages');
select test.denied(format('select public.save_pipeline_stages(%L,%L::jsonb)',test.value('pipeline_ws'),jsonb_set(test.value('pipeline_config')::jsonb,'{0,color}','"javascript:alert(1)"')),'22023','stage color is validated on the server');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000033',false);
select test.denied(format('select public.save_pipeline_stages(%L,%L::jsonb)',test.value('pipeline_ws'),test.value('pipeline_config')),'42501','closer cannot configure stages through RPC');
insert into public.leads(workspace_id,id,owner_id,stage_id,data) values(test.value('pipeline_ws')::uuid,'pipeline-closer',auth.uid(),test.value('custom_stage')::uuid,test.lead('pipeline-closer')),
 (test.value('pipeline_ws')::uuid,'pipeline-source',auth.uid(),test.value('normal_stage')::uuid,test.lead('pipeline-source'));
select test.ok((select data->>'stageId'=test.value('custom_stage') and data->>'stageType'='NORMAL' and data->>'stageName'='Proposta' from public.leads where id='pipeline-closer'),'lead FK supplies canonical stage identity name and type');
select test.denied('update public.leads set loss_reason_grandfathered=true where id=''pipeline-closer''','42501','client cannot forge historical loss exemption');
select test.denied('insert into public.leads(workspace_id,id,owner_id,data,loss_reason_grandfathered) values(test.value(''pipeline_ws'')::uuid,''forged-exemption'',auth.uid(),test.lead(''forged-exemption''),true)','42501','client cannot insert historical loss exemption');
update public.leads set data=data||'{"recordingUrl":"HTTPS://drive.google.com/file/d/recording%20id/view","nextStep":"Retomar proposta"}' where id='pipeline-closer';
select test.ok((select data->>'recordingUrl'='HTTPS://drive.google.com/file/d/recording%20id/view' from public.leads where id='pipeline-closer'),'closer stores valid HTTPS recording with encoded spaces');
select test.ok(private.valid_recording_url('https://example.test./recording'),'HTTPS recording accepts a DNS trailing dot');
select test.ok(private.valid_recording_url('https://[2001:db8::1]:443/recording'),'HTTPS recording accepts a bracketed IPv6 host');
select test.denied('update public.leads set data=data||''{"recordingUrl":"http://example.test/video"}'' where id=''pipeline-closer''','23514','HTTP recording is rejected');
select test.denied('update public.leads set data=data||''{"recordingUrl":"https://user:secret@example.test/video"}'' where id=''pipeline-closer''','23514','recording credentials are rejected');
select test.denied('update public.leads set data=data||''{"recordingUrl":"https://example.test/video%0aInjected"}'' where id=''pipeline-closer''','23514','percent encoded recording controls are rejected');
select test.denied('update public.leads set data=data||''{"recordingUrl":"https://"}'' where id=''pipeline-closer''','23514','recording without host is rejected');
select test.denied(format('update public.leads set data=data||jsonb_build_object(''recordingUrl'',%L) where id=''pipeline-closer''',E'https://example.test/a\\b'),'23514','recording backslashes are rejected');
select test.denied('update public.leads set data=data||jsonb_build_object(''lossComment'',repeat(''a'',4001)) where id=''pipeline-closer''','23514','oversized loss comment is rejected');
select test.denied('update public.leads set data=data||jsonb_build_object(''nextStep'',repeat(''a'',10001)) where id=''pipeline-closer''','23514','oversized next step is rejected');
select test.denied(format('update public.leads set stage_id=%L where id=''pipeline-closer''',test.value('won_stage')),'23514','moving to won requires positive closed value');
update public.leads set stage_id=test.value('won_stage')::uuid,data=data||'{"closedValue":12000,"stageType":"LOST","stageName":"Forged type"}' where id='pipeline-closer';
select test.ok((select data->>'stageType'='WON' and data->>'status'='Fechado' and data->>'attendance'='Compareceu' and data->>'closedAt'<>'' from public.leads where id='pipeline-closer'),'won transition canonicalizes forged type and financial compatibility');
select test.denied(format('update public.leads set stage_id=%L where id=''pipeline-closer''',test.value('lost_stage')),'23514','moving to lost requires loss reason');
update public.leads set stage_id=test.value('lost_stage')::uuid,data=data||'{"lossReason":"Investimento","lossComment":"Cliente decidiu aguardar"}' where id='pipeline-closer';
select test.ok((select data->>'stageType'='LOST' and data->>'status'='Perdido' and data->>'lossReason'='Investimento' from public.leads where id='pipeline-closer'),'lost transition saves reason and comment in canonical stage');
select test.denied('update public.leads set data=jsonb_set(data,''{lossReason}'',''""'') where id=''pipeline-closer''','23514','recorded reason cannot be erased while a new lead remains lost');
select test.denied('update public.leads set data=data-''lossReason'' where id=''pipeline-closer''','23514','recorded reason cannot be removed from lost lead JSON');
update public.leads set stage_id=test.value('won_stage')::uuid where id='pipeline-closer';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000031',false);
insert into public.leads(workspace_id,id,owner_id,stage_id,data) values(test.value('pipeline_ws')::uuid,'pipeline-admin',auth.uid(),test.value('custom_stage')::uuid,test.lead('pipeline-admin'));
select public.save_pipeline_stages(test.value('pipeline_ws')::uuid,(select jsonb_agg(case when entry->>'type'='WON' then jsonb_set(entry,'{name}','"Contrato assinado"') else entry end order by (entry->>'position')::integer) from jsonb_array_elements(public.list_pipeline_stages(test.value('pipeline_ws')::uuid)) entry));
select test.ok((select data->>'stageName'='Contrato assinado' and data->>'stageType'='WON' and (data->>'closedValue')::numeric=12000 from public.leads where id='pipeline-closer'),'renaming won stage preserves stage type and revenue');
select test.ok((select sum((l.data->>'closedValue')::numeric)=12000 from public.leads l join public.pipeline_stages s on s.workspace_id=l.workspace_id and s.id=l.stage_id where l.workspace_id=test.value('pipeline_ws')::uuid and s.type='WON'),'revenue is calculated by type independent of editable stage name');
update test.context set value=public.list_pipeline_stages(test.value('pipeline_ws')::uuid)::text where key='pipeline_config';
select test.denied(format('select public.save_pipeline_stages(%L,%L::jsonb)',test.value('pipeline_ws'),(select jsonb_agg(entry) from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry where entry->>'id'<>test.value('custom_stage'))),'23514','occupied stage cannot be omitted for deletion');
select test.ok((select name='Proposta' from public.pipeline_stages where id=test.value('custom_stage')::uuid),'failed configuration is atomic and preserves occupied stage');
select test.denied(format('select public.save_pipeline_stages(%L,%L::jsonb)',test.value('pipeline_ws'),(select jsonb_agg(case when entry->>'id'=test.value('custom_stage') then entry||'{"type":"WON","active":false}'::jsonb else entry end) from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry)),'23514','occupied stage type cannot be changed');
select public.save_pipeline_stages(test.value('pipeline_ws')::uuid,(select jsonb_agg(case when entry->>'id'=test.value('custom_stage') then jsonb_set(entry,'{active}','false') else entry end order by (entry->>'position')::integer) from jsonb_array_elements(test.value('pipeline_config')::jsonb) entry));
select test.ok((select not active from public.pipeline_stages where id=test.value('custom_stage')::uuid),'admin may deactivate occupied normal stage without deleting leads');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000033',false);
select test.denied(format('update public.leads set stage_id=%L where id=''pipeline-source''',test.value('custom_stage')),'23514','lead cannot move into inactive stage');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000031',false);
update public.leads set data=data||'{"nextStep":"Contato em etapa inativa"}' where id='pipeline-admin';
select test.ok((select data->>'nextStep'='Contato em etapa inativa' from public.leads where id='pipeline-admin'),'existing inactive-stage lead remains editable');
insert into test.context values('empty_stage',(select entry->>'id' from jsonb_array_elements(public.save_pipeline_stages(test.value('pipeline_ws')::uuid,public.list_pipeline_stages(test.value('pipeline_ws')::uuid)||'[{"name":"Etapa vazia","color":"#64748b","type":"NORMAL","active":true}]')) entry where entry->>'name'='Etapa vazia'));
select public.save_pipeline_stages(test.value('pipeline_ws')::uuid,(select jsonb_agg(entry order by (entry->>'position')::integer) from jsonb_array_elements(public.list_pipeline_stages(test.value('pipeline_ws')::uuid)) entry where entry->>'id'<>test.value('empty_stage')));
select test.ok(not exists(select 1 from public.pipeline_stages where id=test.value('empty_stage')::uuid),'empty stage can be safely deleted');
select test.ok((select entry->>'lead_count'='1' from jsonb_array_elements(public.list_pipeline_stages(test.value('pipeline_ws')::uuid)) entry where entry->>'id'=test.value('custom_stage')),'stage counts include retained inactive leads');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000032',false);
select test.ok((select data->>'recordingUrl' like 'HTTPS://drive%' from public.leads where id='pipeline-closer'),'manager can view recording within company');
insert into test.context values('review_result',public.review_call(test.value('pipeline_ws')::uuid,'pipeline-closer','  Aprofunde o diagnóstico antes da proposta  ',9)::text);
select test.ok(test.value('review_result')::jsonb->>'feedback'='Aprofunde o diagnóstico antes da proposta' and test.value('review_result')::jsonb->>'reviewed_by'=auth.uid()::text,'manager review stores trimmed feedback and server reviewer identity');
select test.ok((test.value('review_result')::jsonb->>'reviewed_at')::timestamptz between now()-interval '1 minute' and now(),'leadership review records server timestamp');
select test.ok(test.value('review_result')::jsonb ? 'reviewer_name','review result includes authorized reviewer name');
select test.denied(format('select public.review_call(%L,''pipeline-closer'','' '',8)',test.value('pipeline_ws')),'22023','blank leadership feedback is rejected');
select test.denied(format('select public.review_call(%L,''pipeline-closer'',''Teste'',11)',test.value('pipeline_ws')),'22023','invalid leadership score is rejected');
select test.denied(format('select public.review_call(%L,''b-lead'',''Teste'',8)',test.value('pipeline_ws')),'P0002','leadership review cannot cross company by lead id');
select test.denied('update public.call_reviews set score=10','42501','direct leadership review updates are denied');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000033',false);
select test.ok(jsonb_array_length(public.list_call_reviews(test.value('pipeline_ws')::uuid))=1,'closer sees review of own call');
select test.denied(format('select public.review_call(%L,''pipeline-closer'',''Forged'',10)',test.value('pipeline_ws')),'42501','closer cannot write leadership review through RPC');
update public.leads set data=data||'{"leadershipReview":{"feedback":"Forged","score":10,"reviewedBy":"00000000-0000-0000-0000-000000000033"}}' where id='pipeline-closer';
select test.ok((select not(data ? 'leadershipReview') from public.leads where id='pipeline-closer'),'ordinary lead JSON cannot carry forged leadership review');
select test.ok((select score=9 and feedback='Aprofunde o diagnóstico antes da proposta' from public.call_reviews where lead_id='pipeline-closer'),'ordinary lead update cannot overwrite stored leadership review');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000034',false);
select test.ok(jsonb_array_length(public.list_call_reviews(test.value('pipeline_ws')::uuid))=1,'authorized viewer can read leadership review');
select test.denied(format('select public.review_call(%L,''pipeline-closer'',''Viewer forged'',10)',test.value('pipeline_ws')),'42501','viewer cannot write leadership review');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000035',false);
select test.ok((select count(*)=0 from public.pipeline_stages),'other company user cannot read stage table');
select test.ok((select count(*)=0 from public.call_reviews),'other company user cannot read call review table');
select test.denied(format('select public.list_call_reviews(%L)',test.value('pipeline_ws')),'42501','other company user cannot list call reviews through RPC');
select test.denied(format('select public.list_pipeline_stages(%L)',test.value('pipeline_ws')),'42501','other company user cannot list pipeline through RPC');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.denied(format('select public.review_call(%L,''pipeline-closer'',''Operator forged'',10)',test.value('pipeline_ws')),'42501','platform role alone cannot review a customer call');
reset role;
insert into test.context values('foreign_stage',(select id::text from public.pipeline_stages where workspace_id=test.value('b')::uuid order by position limit 1));
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000033',false);
select test.denied(format('update public.leads set stage_id=%L where id=''pipeline-source''',test.value('foreign_stage')),'23514','lead stage foreign key cannot reference another company');
select test.ok((public.import_leads(test.value('pipeline_ws')::uuid,jsonb_build_array(test.lead('foreign-import')||jsonb_build_object('stageId',test.value('foreign_stage'),'stageName','Lead novo','stageType','NORMAL')))->>'imported')::integer=1,'import maps foreign stage identity to company local stage');
select test.ok((select stage_id=test.value('normal_stage')::uuid from public.leads where id='foreign-import'),'import never retains foreign company stage id');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000031',false);
-- Cross-company backups retain business kind when editable names collide with other types.
select public.save_pipeline_stages(test.value('pipeline_ws')::uuid,(select jsonb_agg(case
  when entry->>'id'=test.value('normal_stage') then jsonb_set(entry,'{name}','"Contrato assinado"')
  when entry->>'name'='Follow-up' then jsonb_set(entry,'{name}','"Perdido"') else entry end order by (entry->>'position')::integer)
  from jsonb_array_elements(public.list_pipeline_stages(test.value('pipeline_ws')::uuid)) entry));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000033',false);
select test.ok((public.import_leads(test.value('pipeline_ws')::uuid,jsonb_build_array(
  test.lead('colliding-won')||jsonb_build_object('stageId',test.value('foreign_stage'),'stageName','Contrato assinado','stageType','WON','status','Fechado','closedValue',54321,'closedAt','2026-10-07T12:00:00.000Z','attendance','Compareceu'),
  test.lead('colliding-lost')||jsonb_build_object('stageId',test.value('foreign_stage'),'stageName','Perdido','stageType','LOST','status','Perdido','lossReason','Timing','lossComment','Motivo original do backup'),
  test.lead('colliding-normal')||jsonb_build_object('stageId',test.value('foreign_stage'),'stageName','Contrato assinado','stageType','NORMAL'),
  test.lead('colliding-legacy-won')||jsonb_build_object('stageId',test.value('foreign_stage'),'stageName','Contrato assinado','status','Fechado','closedValue',67890,'closedAt','2026-10-07T12:00:00.000Z','attendance','Compareceu'),
  test.lead('colliding-legacy-lost')||jsonb_build_object('stageId',test.value('foreign_stage'),'stageName','Perdido','status','Perdido','lossReason','Investimento','lossComment','Razão do backup legado'),
  test.lead('local-fk-authoritative')||jsonb_build_object('stageId',test.value('normal_stage'),'stageName','Contrato assinado','stageType','WON','status','Fechado','closedValue',1000,'closedAt','2026-10-07T12:00:00.000Z','attendance','Compareceu')
))->>'imported')::integer=6,'cross-company backup collision fixtures import atomically');
select test.ok((select stage_id=test.value('won_stage')::uuid and data->>'stageType'='WON' and (data->>'closedValue')::numeric=54321 from public.leads where id='colliding-won'),'backup won kind and closed value survive same-name normal collision');
select test.ok((select stage_id=test.value('lost_stage')::uuid and data->>'stageType'='LOST' and data->>'lossReason'='Timing' and data->>'lossComment'='Motivo original do backup' from public.leads where id='colliding-lost'),'backup lost kind reason and comment survive same-name normal collision');
select test.ok((select stage_id=test.value('normal_stage')::uuid and data->>'stageType'='NORMAL' and data->>'status'='Lead novo' from public.leads where id='colliding-normal'),'backup normal kind is never promoted by a same-name won stage');
select test.ok((select stage_id=test.value('won_stage')::uuid and data->>'stageType'='WON' and (data->>'closedValue')::numeric=67890 from public.leads where id='colliding-legacy-won'),'legacy backup without stage type infers won before matching names');
select test.ok((select stage_id=test.value('lost_stage')::uuid and data->>'stageType'='LOST' and data->>'lossReason'='Investimento' and data->>'lossComment'='Razão do backup legado' from public.leads where id='colliding-legacy-lost'),'legacy backup without stage type infers lost before matching names');
select test.ok((select stage_id=test.value('normal_stage')::uuid and data->>'stageType'='NORMAL' from public.leads where id='local-fk-authoritative'),'valid same-company stage id remains authoritative during import');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000031',false);
select test.ok(jsonb_array_length(public.export_workspace(test.value('pipeline_ws')::uuid)->'pipelines')=1 and jsonb_array_length(public.export_workspace(test.value('pipeline_ws')::uuid)->'pipeline_stages')=8 and jsonb_array_length(public.export_workspace(test.value('pipeline_ws')::uuid)->'call_reviews')=1,'company backup includes pipeline configuration and independent leadership reviews');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.admin_update_subscription(test.value('pipeline_ws')::uuid,'team','suspended',4);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000031',false);
select test.denied(format('select public.list_pipeline_stages(%L)',test.value('pipeline_ws')),'42501','suspended subscription blocks pipeline RPC');
select test.denied(format('select public.list_call_reviews(%L)',test.value('pipeline_ws')),'42501','suspended subscription blocks leadership review RPC');
select test.ok(jsonb_array_length(public.export_workspace(test.value('pipeline_ws')::uuid)->'call_reviews')=1,'suspended company administrator retains full new-data portability');
select public.delete_workspace(test.value('pipeline_ws')::uuid,'Pipeline configurável');
reset role;
select test.ok(not exists(select 1 from public.call_reviews where workspace_id=test.value('pipeline_ws')::uuid),'company deletion cascades independent leadership reviews');
select test.ok(not exists(select 1 from public.pipeline_stages where workspace_id=test.value('pipeline_ws')::uuid),'company deletion cascades configurable pipeline');
select 'Pipeline and call review assertions passed: '||count(*) from test.results;
