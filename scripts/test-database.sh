#!/usr/bin/env bash
# Run only against a disposable local Docker database, never a configured Supabase project.
set -euo pipefail
TASK_DB_CONTAINER="${CLOSER_OS_TEST_DB_CONTAINER:-closer-os-db-tests}"
TASK_DB_NAME="closer_os_test_${$}_$(date +%s)"
TASK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_LOG_DIR="$(mktemp -d /tmp/closer-os-db-test.XXXXXX)"
TASK_CREATED_CONTAINER=false
# Only the new external-import races keep psql inputs open while coordinating locks.
declare -A TASK_EXTERNAL_PIDS=() TASK_EXTERNAL_FDS=()
cleanup() {
  local task_fd
  for task_fd in "${TASK_EXTERNAL_FDS[@]}"; do exec {task_fd}>&-; done
  # Terminate only this generated disposable database on a failed barrier.
  # Otherwise an open transaction could prevent its final dropdb.
  if [ "${#TASK_EXTERNAL_PIDS[@]}" -gt 0 ]; then
    docker exec "$TASK_DB_CONTAINER" psql -X -q -U postgres -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$TASK_DB_NAME';" >/dev/null 2>&1 || true
  fi
  docker exec "$TASK_DB_CONTAINER" dropdb -U postgres --if-exists "$TASK_DB_NAME" >/dev/null 2>&1 || true
  if [ "$TASK_CREATED_CONTAINER" = true ]; then docker rm -f "$TASK_DB_CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$TASK_LOG_DIR"
}
trap cleanup EXIT
if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for isolated database verification.' >&2; exit 1
fi
if ! docker inspect "$TASK_DB_CONTAINER" >/dev/null 2>&1; then
  docker run -d --name "$TASK_DB_CONTAINER" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
  TASK_CREATED_CONTAINER=true
  for attempt in $(seq 1 30); do
    # The image uses a socket-only temporary server during initialization. Wait
    # for its final TCP listener, rather than racing createdb against that restart.
    if docker exec "$TASK_DB_CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
docker exec "$TASK_DB_CONTAINER" createdb -U postgres "$TASK_DB_NAME"
psql_local() { docker exec -i "$TASK_DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$TASK_DB_NAME" "$@"; }
psql_local < "$TASK_REPO_ROOT/supabase/tests/auth-stub.sql" >/dev/null
for task_migration in "$TASK_REPO_ROOT"/supabase/migrations/*.sql; do
  if [[ "$task_migration" == *202610070004_custom_pipeline_call_reviews.sql ]]; then
    psql_local < "$TASK_REPO_ROOT/supabase/tests/pre-pipeline-migration.sql" >/dev/null
  fi
  if [[ "$task_migration" == *202610080006_lead_activities_timeline.sql ]]; then
    psql_local < "$TASK_REPO_ROOT/supabase/tests/pre-activities-migration.sql" >/dev/null
  fi
  psql_local < "$task_migration" >/dev/null
  if [[ "$task_migration" == *202610070004_custom_pipeline_call_reviews.sql ]]; then
    psql_local < "$TASK_REPO_ROOT/supabase/tests/post-pipeline-migration.sql" >/dev/null
  fi
  if [[ "$task_migration" == *202610080006_lead_activities_timeline.sql ]]; then
    psql_local < "$TASK_REPO_ROOT/supabase/tests/post-activities-migration.sql" >/dev/null
  fi
done
if ! psql_local < "$TASK_REPO_ROOT/supabase/tests/rls.sql" > "$TASK_LOG_DIR/rls.log" 2>&1; then
  cat "$TASK_LOG_DIR/rls.log" >&2; exit 1
fi
sed -n '/SQL assertions passed:/p' "$TASK_LOG_DIR/rls.log"
psql_local -Atc "insert into test.results select label from migration_test.results;" >/dev/null
for task_assertions in self-service invitation-details pipeline-call-reviews account-names lead-activities inbound-integrations platform-company-administration call-scheduling external-lead-import; do
  if ! psql_local < "$TASK_REPO_ROOT/supabase/tests/$task_assertions.sql" > "$TASK_LOG_DIR/$task_assertions.log" 2>&1; then
    cat "$TASK_LOG_DIR/$task_assertions.log" >&2; exit 1
  fi
  sed -n '/assertions passed:/p' "$TASK_LOG_DIR/$task_assertions.log"
done
# Both transactions target the same last available seat. The workspace lock must serialize them.
TASK_RACE_ID="$(psql_local -Atc "select test.value('race')")"
(
  psql_local > "$TASK_LOG_DIR/race-a.log" 2>&1 <<SQL
begin;
select id from public.workspaces where id='$TASK_RACE_ID' for update;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select public.invite_member('$TASK_RACE_ID','race-one@example.test','admin')->>'id';
select pg_sleep(1);
commit;
SQL
) & TASK_FIRST_PID=$!
(
  psql_local > "$TASK_LOG_DIR/race-b.log" 2>&1 <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select public.invite_member('$TASK_RACE_ID','race-two@example.test','admin')->>'id';
commit;
SQL
) & TASK_SECOND_PID=$!
TASK_FIRST_STATUS=0; wait "$TASK_FIRST_PID" || TASK_FIRST_STATUS=$?
TASK_SECOND_STATUS=0; wait "$TASK_SECOND_PID" || TASK_SECOND_STATUS=$?
if { [ "$TASK_FIRST_STATUS" -eq 0 ] && [ "$TASK_SECOND_STATUS" -eq 0 ]; } || { [ "$TASK_FIRST_STATUS" -ne 0 ] && [ "$TASK_SECOND_STATUS" -ne 0 ]; }; then
  cat "$TASK_LOG_DIR/race-a.log" "$TASK_LOG_DIR/race-b.log" >&2
  echo 'FAILED: exactly one simultaneous last-seat invitation should succeed.' >&2; exit 1
fi
if [ "$TASK_FIRST_STATUS" -ne 0 ]; then TASK_REJECT_LOG="$TASK_LOG_DIR/race-a.log"; else TASK_REJECT_LOG="$TASK_LOG_DIR/race-b.log"; fi
if ! grep -q 'Limite de acessos atingido' "$TASK_REJECT_LOG"; then cat "$TASK_REJECT_LOG" >&2; exit 1; fi
psql_local -Atc "select test.ok((select count(*)=1 from public.invitations where workspace_id='$TASK_RACE_ID' and accepted_at is null and revoked_at is null),'concurrent invitations respect single seat');" >/dev/null
echo 'Concurrent seat-reservation test passed.'
# The same single-use callback must never create two accepted memberships.
accept_once() {
  psql_local <<'SQL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',true);
select public.accept_invitation(test.value('accept_race_token'));
select pg_sleep(1);
commit;
SQL
}
accept_once > "$TASK_LOG_DIR/accept-a.log" 2>&1 & TASK_FIRST_PID=$!
accept_once > "$TASK_LOG_DIR/accept-b.log" 2>&1 & TASK_SECOND_PID=$!
TASK_FIRST_STATUS=0; wait "$TASK_FIRST_PID" || TASK_FIRST_STATUS=$?
TASK_SECOND_STATUS=0; wait "$TASK_SECOND_PID" || TASK_SECOND_STATUS=$?
if { [ "$TASK_FIRST_STATUS" -eq 0 ] && [ "$TASK_SECOND_STATUS" -eq 0 ]; } || { [ "$TASK_FIRST_STATUS" -ne 0 ] && [ "$TASK_SECOND_STATUS" -ne 0 ]; }; then
  cat "$TASK_LOG_DIR/accept-a.log" "$TASK_LOG_DIR/accept-b.log" >&2; exit 1
fi
if [ "$TASK_FIRST_STATUS" -ne 0 ]; then TASK_REJECT_LOG="$TASK_LOG_DIR/accept-a.log"; else TASK_REJECT_LOG="$TASK_LOG_DIR/accept-b.log"; fi
if ! grep -q 'Convite inválido ou expirado' "$TASK_REJECT_LOG"; then cat "$TASK_REJECT_LOG" >&2; exit 1; fi
psql_local -Atc "select test.ok((select count(*)=1 from public.memberships where workspace_id=test.value('accept_race')::uuid),'parallel invitation callbacks accept exactly once');" >/dev/null
echo 'Concurrent single-use invitation test passed.'
# Authorization is checked after acquiring the tenant lock: a just-deactivated admin cannot retaliate.
deactivate_other() {
  local task_actor="$1" task_other="$2"
  psql_local <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','$task_actor',true);
select public.update_member(test.value('admin_race')::uuid,'$task_other','admin',false);
select pg_sleep(1);
commit;
SQL
}
deactivate_other '00000000-0000-0000-0000-000000000009' '00000000-0000-0000-0000-000000000010' > "$TASK_LOG_DIR/admin-a.log" 2>&1 & TASK_FIRST_PID=$!
deactivate_other '00000000-0000-0000-0000-000000000010' '00000000-0000-0000-0000-000000000009' > "$TASK_LOG_DIR/admin-b.log" 2>&1 & TASK_SECOND_PID=$!
TASK_FIRST_STATUS=0; wait "$TASK_FIRST_PID" || TASK_FIRST_STATUS=$?
TASK_SECOND_STATUS=0; wait "$TASK_SECOND_PID" || TASK_SECOND_STATUS=$?
if { [ "$TASK_FIRST_STATUS" -eq 0 ] && [ "$TASK_SECOND_STATUS" -eq 0 ]; } || { [ "$TASK_FIRST_STATUS" -ne 0 ] && [ "$TASK_SECOND_STATUS" -ne 0 ]; }; then
  cat "$TASK_LOG_DIR/admin-a.log" "$TASK_LOG_DIR/admin-b.log" >&2; exit 1
fi
if [ "$TASK_FIRST_STATUS" -ne 0 ]; then TASK_REJECT_LOG="$TASK_LOG_DIR/admin-a.log"; else TASK_REJECT_LOG="$TASK_LOG_DIR/admin-b.log"; fi
if ! grep -q 'Acesso administrativo não autorizado' "$TASK_REJECT_LOG"; then cat "$TASK_REJECT_LOG" >&2; exit 1; fi
psql_local -Atc "select test.ok((select count(*)=2 from public.memberships where workspace_id=test.value('admin_race')::uuid and is_active),'concurrent admin revocation preserves owner and authorized actor');" >/dev/null
echo 'Concurrent administrator-revocation test passed.'
# Two initial registrations for the same verified account must return one company and one trial.
create_self_once() {
  psql_local -At <<'SQL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub',test.value('self_race'),true);
select public.create_own_workspace('Empresa concorrente','Cliente concorrente',true);
select pg_sleep(1);
commit;
SQL
}
create_self_once > "$TASK_LOG_DIR/self-a.log" 2>&1 & TASK_FIRST_PID=$!
create_self_once > "$TASK_LOG_DIR/self-b.log" 2>&1 & TASK_SECOND_PID=$!
TASK_FIRST_STATUS=0; wait "$TASK_FIRST_PID" || TASK_FIRST_STATUS=$?
TASK_SECOND_STATUS=0; wait "$TASK_SECOND_PID" || TASK_SECOND_STATUS=$?
if [ "$TASK_FIRST_STATUS" -ne 0 ] || [ "$TASK_SECOND_STATUS" -ne 0 ]; then cat "$TASK_LOG_DIR/self-a.log" "$TASK_LOG_DIR/self-b.log" >&2; exit 1; fi
psql_local -Atc "select test.ok((select count(*)=1 from private.self_service_registrations where user_id=test.value('self_race')::uuid),'parallel public registrations share one allowance');
select test.ok((select count(*)=1 from public.workspaces where owner_id=test.value('self_race')::uuid),'parallel public registrations share one company');
select test.ok((select count(*)=1 from public.memberships where user_id=test.value('self_race')::uuid and role='admin' and is_active),'parallel public registrations create one administrator membership');
select test.ok((select count(*)=1 from public.subscriptions s join private.self_service_registrations r on r.workspace_id=s.workspace_id where r.user_id=test.value('self_race')::uuid and s.status='trial' and s.seat_limit=1),'parallel public registrations create one trial');
select test.ok((select count(*)=1 from public.audit_logs where actor_id=test.value('self_race')::uuid and action='workspace.self_service_created'),'parallel public registrations audit creation once');
select test.ok((select count(*)=2 from public.policy_acceptances where user_id=test.value('self_race')::uuid),'parallel public registrations record two policy documents once');" >/dev/null
echo 'Concurrent public-registration test passed.'
# Completing and cancelling the same pending task must produce only one terminal transition.
finish_activity_once() {
  local task_final_status="$1"
  psql_local <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000064',true);
select public.set_activity_status(test.value('activities_ws_b')::uuid,test.value('activities_status_race')::uuid,'$task_final_status');
select pg_sleep(1);
commit;
SQL
}
finish_activity_once completed > "$TASK_LOG_DIR/activity-complete.log" 2>&1 & TASK_FIRST_PID=$!
finish_activity_once cancelled > "$TASK_LOG_DIR/activity-cancel.log" 2>&1 & TASK_SECOND_PID=$!
TASK_FIRST_STATUS=0; wait "$TASK_FIRST_PID" || TASK_FIRST_STATUS=$?
TASK_SECOND_STATUS=0; wait "$TASK_SECOND_PID" || TASK_SECOND_STATUS=$?
if { [ "$TASK_FIRST_STATUS" -eq 0 ] && [ "$TASK_SECOND_STATUS" -eq 0 ]; } || { [ "$TASK_FIRST_STATUS" -ne 0 ] && [ "$TASK_SECOND_STATUS" -ne 0 ]; }; then
  cat "$TASK_LOG_DIR/activity-complete.log" "$TASK_LOG_DIR/activity-cancel.log" >&2; exit 1
fi
if [ "$TASK_FIRST_STATUS" -ne 0 ]; then TASK_REJECT_LOG="$TASK_LOG_DIR/activity-complete.log"; else TASK_REJECT_LOG="$TASK_LOG_DIR/activity-cancel.log"; fi
if ! grep -q 'Atividade já finalizada' "$TASK_REJECT_LOG"; then cat "$TASK_REJECT_LOG" >&2; exit 1; fi
psql_local -Atc "select test.ok((select count(*)=1 from public.lead_events where workspace_id=test.value('activities_ws_b')::uuid and metadata->>'activity_id'=test.value('activities_status_race') and event_type in ('activity.completed','activity.cancelled')),'concurrent activity finalization records one terminal event');" >/dev/null
echo 'Concurrent activity-finalization test passed.'
# Inbound uses the real service-role RPC and fresh fake fixtures in this database.
TASK_INBOUND_WS="$(psql_local -Atc "select test.value('inbound_race_ws')")"
TASK_INBOUND_INT="$(psql_local -Atc "select test.value('inbound_race_int')")"
TASK_INBOUND_HASH="$(psql_local -Atc "select test.value('inbound_race_hash')")"
TASK_INBOUND_OTHER_HASH="$(psql_local -Atc "select test.value('inbound_hash_b')")"
TASK_INBOUND_RATE_INT="$(psql_local -Atc "select test.value('inbound_rate_race_int')")"
TASK_INBOUND_RATE_HASH="$(psql_local -Atc "select test.value('inbound_rate_race_hash')")"
inbound_once() {
  local task_hash="$1" task_email="$2"
  psql_local -At <<SQL
begin;
set local role service_role;
select public.receive_inbound_lead('$task_hash',gen_random_uuid(),jsonb_build_object('name','Concorrência local','email','$task_email'))->>'status';
select pg_sleep(1);
commit;
SQL
}
inbound_wait_both() {
  local task_label="$1"
  TASK_FIRST_STATUS=0; wait "$TASK_FIRST_PID" || TASK_FIRST_STATUS=$?
  TASK_SECOND_STATUS=0; wait "$TASK_SECOND_PID" || TASK_SECOND_STATUS=$?
  if [ "$TASK_FIRST_STATUS" -ne 0 ] || [ "$TASK_SECOND_STATUS" -ne 0 ]; then
    cat "$TASK_LOG_DIR/inbound-a.log" "$TASK_LOG_DIR/inbound-b.log" >&2
    echo "FAILED: $task_label" >&2; exit 1
  fi
}
inbound_once "$TASK_INBOUND_HASH" 'inbound-race@example.test' > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_once "$TASK_INBOUND_HASH" 'inbound-race@example.test' > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'same-integration inbound requests'
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_INBOUND_WS' and data->>'email'='inbound-race@example.test'),'concurrent inbound requests create one lead');
select test.ok((select created_count=1 and duplicate_count=1 from public.inbound_integrations where id='$TASK_INBOUND_INT'),'concurrent inbound requests count one creation and one duplicate');
select test.ok((select count(*)=1 from public.lead_events e join public.leads l on l.workspace_id=e.workspace_id and l.id=e.lead_id where l.workspace_id='$TASK_INBOUND_WS' and l.data->>'email'='inbound-race@example.test' and e.event_type='lead.inbound_received'),'concurrent inbound requests create one receipt event');" >/dev/null
echo 'Concurrent same-integration inbound test passed.'
inbound_once "$TASK_INBOUND_HASH" 'inbound-cross-integration@example.test' > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_once "$TASK_INBOUND_OTHER_HASH" 'inbound-cross-integration@example.test' > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'different integrations in the same tenant'
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_INBOUND_WS' and data->>'email'='inbound-cross-integration@example.test'),'different integrations atomically deduplicate inside one tenant');" >/dev/null
echo 'Concurrent same-tenant integration test passed.'

# Markers live only in this disposable database; they make the manual writer
# enter its critical section before starting the inbound transaction.
inbound_wait_marker() {
  local task_marker="$1"
  for task_attempt in $(seq 1 40); do
    if [ "$(psql_local -Atc "select exists(select 1 from pg_locks where locktype='advisory' and objid=$task_marker and granted)")" = t ]; then return; fi
    sleep 0.05
  done
  echo 'FAILED: concurrent inbound fixture did not reach its barrier.' >&2; exit 1
}
(
  psql_local -At <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000084',true);
insert into public.leads(workspace_id,id,owner_id,data) values('$TASK_INBOUND_WS','inbound-manual-insert-race','00000000-0000-0000-0000-000000000084',
  test.lead('inbound-manual-insert-race')||jsonb_build_object('email','manual-before-inbound@example.test'));
select pg_advisory_xact_lock(637181);
select pg_sleep(1);
commit;
SQL
) > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_wait_marker 637181
inbound_once "$TASK_INBOUND_HASH" 'manual-before-inbound@example.test' > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'manual insert before inbound'
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_INBOUND_WS' and data->>'email'='manual-before-inbound@example.test'),'inbound sees manual insert committed while waiting for workspace');
select test.ok(exists(select 1 from public.inbound_integration_logs where integration_id='$TASK_INBOUND_INT' and status='duplicate' and duplicate_lead_id='inbound-manual-insert-race'),'manual insert wins without duplicate overwrite');" >/dev/null
echo 'Concurrent manual-insert inbound test passed.'

psql_local -Atc "insert into public.leads(workspace_id,id,owner_id,data) values('$TASK_INBOUND_WS','inbound-manual-update-race','00000000-0000-0000-0000-000000000084',
test.lead('inbound-manual-update-race')||jsonb_build_object('email','old-contact@example.test'));" >/dev/null
(
  psql_local -At <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000084',true);
update public.leads set data=data||jsonb_build_object('email','updated-before-inbound@example.test') where workspace_id='$TASK_INBOUND_WS' and id='inbound-manual-update-race';
select pg_advisory_xact_lock(637182);
select pg_sleep(1);
commit;
SQL
) > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_wait_marker 637182
inbound_once "$TASK_INBOUND_HASH" 'updated-before-inbound@example.test' > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'manual update before inbound'
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_INBOUND_WS' and data->>'email'='updated-before-inbound@example.test'),'inbound sees latest manual identity after waiting for tenant lock');" >/dev/null
echo 'Concurrent manual-update inbound test passed.'

# A direct writer can own the lead row BEFORE its existing trigger requests the
# workspace. Inbound must finish without trying to lock that existing lead.
(
  psql_local -At <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000084',true);
select id from public.leads where workspace_id='$TASK_INBOUND_WS' and id='inbound-manual-update-race' for update;
select pg_advisory_xact_lock(637183);
select pg_sleep(1);
update public.leads set data=data||jsonb_build_object('notes','Edição manual após lock de linha') where workspace_id='$TASK_INBOUND_WS' and id='inbound-manual-update-race';
commit;
SQL
) > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_wait_marker 637183
inbound_once "$TASK_INBOUND_HASH" 'updated-before-inbound@example.test' > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'manual lead-row lock before inbound workspace lock'
if ! rg -q '^duplicate$' "$TASK_LOG_DIR/inbound-b.log"; then cat "$TASK_LOG_DIR/inbound-b.log" >&2; exit 1; fi
psql_local -Atc "select test.ok((select data->>'notes'='Edição manual após lock de linha' from public.leads where workspace_id='$TASK_INBOUND_WS' and id='inbound-manual-update-race'),'manual row-first update and inbound duplicate finish without deadlock');" >/dev/null
echo 'Concurrent lead-row lock inbound test passed.'

(
  psql_local -At <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000084',true);
select id from public.leads where workspace_id='$TASK_INBOUND_WS' and id='inbound-manual-update-race' for update;
select pg_advisory_xact_lock(637184);
select pg_sleep(1);
delete from public.leads where workspace_id='$TASK_INBOUND_WS' and id='inbound-manual-update-race';
commit;
SQL
) > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_wait_marker 637184
inbound_once "$TASK_INBOUND_HASH" 'updated-before-inbound@example.test' > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'manual delete with inbound duplicate'
if ! rg -q '^duplicate$' "$TASK_LOG_DIR/inbound-b.log"; then cat "$TASK_LOG_DIR/inbound-b.log" >&2; exit 1; fi
psql_local -Atc "select test.ok(not exists(select 1 from public.leads where workspace_id='$TASK_INBOUND_WS' and id='inbound-manual-update-race'),'concurrent manual delete completes with nonlocking inbound reference');" >/dev/null
echo 'Concurrent manual-delete inbound test passed.'

# Keep both minute-limited transactions comfortably within one UTC minute.
TASK_INBOUND_SECONDS_LEFT="$(psql_local -Atc "select floor(extract(epoch from date_trunc('minute',clock_timestamp())+interval '1 minute'-clock_timestamp()))::integer")"
if [ "$TASK_INBOUND_SECONDS_LEFT" -lt 5 ]; then sleep "$((TASK_INBOUND_SECONDS_LEFT+1))"; fi
psql_local -Atc "update private.inbound_rate_limits set window_start=date_trunc('minute',clock_timestamp()),hits=119 where bucket_key='integration:$TASK_INBOUND_RATE_INT:minute';" >/dev/null
inbound_once "$TASK_INBOUND_RATE_HASH" 'quota-race-one@example.test' > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_once "$TASK_INBOUND_RATE_HASH" 'quota-race-two@example.test' > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'last inbound quota slot'
psql_local -Atc "select test.ok((select created_count=1 and error_count=1 from public.inbound_integrations where id='$TASK_INBOUND_RATE_INT'),'parallel inbound quota admits one and rejects one');
select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_INBOUND_WS' and data->>'email' in ('quota-race-one@example.test','quota-race-two@example.test')),'last inbound quota slot creates exactly one lead');" >/dev/null
echo 'Concurrent last inbound-quota test passed.'

# Cleanup must not remove an expired row refreshed by a concurrent receiver.
psql_local -Atc "update private.inbound_rate_limits set hits=77,updated_at=clock_timestamp()-interval '3 days' where bucket_key='integration:$TASK_INBOUND_INT:day';" >/dev/null
(
  psql_local -At <<SQL
begin;
set local role service_role;
update private.inbound_rate_limits set hits=78,updated_at=clock_timestamp() where bucket_key='integration:$TASK_INBOUND_INT:day';
select pg_advisory_xact_lock(637185);
select pg_sleep(1);
commit;
SQL
) > "$TASK_LOG_DIR/inbound-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_wait_marker 637185
(
  psql_local -At <<'SQL'
set role service_role;
select public.purge_inbound_integration_logs(200);
SQL
) > "$TASK_LOG_DIR/inbound-b.log" 2>&1 & TASK_SECOND_PID=$!
inbound_wait_both 'renewed quota versus cleanup'
psql_local -Atc "select test.ok((select hits=78 and updated_at>clock_timestamp()-interval '1 minute' from private.inbound_rate_limits where bucket_key='integration:$TASK_INBOUND_INT:day'),'quota cleanup preserves concurrently renewed bucket');" >/dev/null
echo 'Concurrent inbound-quota cleanup test passed.'

# Master deletion serializes on the existing workspace row. A second irreversible
# request must fail after the first commits, without duplicate deletion receipts.
TASK_MASTER_DELETE_WS="$(psql_local -Atc "select test.value('master_delete_race')")"
(
  psql_local -At <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000120',true);
select public.platform_delete_workspace('$TASK_MASTER_DELETE_WS','Empresa Master concorrente',true,true,'Autorização para teste concorrente local');
select pg_advisory_xact_lock(637186);
select pg_sleep(1);
commit;
SQL
) > "$TASK_LOG_DIR/master-delete-a.log" 2>&1 & TASK_FIRST_PID=$!
inbound_wait_marker 637186
(
  psql_local -At <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000120',true);
select public.platform_delete_workspace('$TASK_MASTER_DELETE_WS','Empresa Master concorrente',true,true,'Autorização para teste concorrente local');
commit;
SQL
) > "$TASK_LOG_DIR/master-delete-b.log" 2>&1 & TASK_SECOND_PID=$!
TASK_FIRST_STATUS=0; wait "$TASK_FIRST_PID" || TASK_FIRST_STATUS=$?
TASK_SECOND_STATUS=0; wait "$TASK_SECOND_PID" || TASK_SECOND_STATUS=$?
if [ "$TASK_FIRST_STATUS" -ne 0 ] || [ "$TASK_SECOND_STATUS" -eq 0 ]; then
  cat "$TASK_LOG_DIR/master-delete-a.log" "$TASK_LOG_DIR/master-delete-b.log" >&2; exit 1
fi
if ! rg -q 'Empresa não encontrada' "$TASK_LOG_DIR/master-delete-b.log"; then cat "$TASK_LOG_DIR/master-delete-b.log" >&2; exit 1; fi
psql_local -Atc "select test.ok((select count(*)=1 from private.workspace_deletion_receipts where workspace_id='$TASK_MASTER_DELETE_WS'),'master: concurrent deletions preserve one independent receipt');
select test.ok(not exists(select 1 from public.workspaces where id='$TASK_MASTER_DELETE_WS'),'master: concurrent deletion leaves no half-deleted workspace');" >/dev/null
echo 'Concurrent Master workspace-deletion test passed.'

# External imports must serialize with all existing tenant writers. FIFO-backed
# psql sessions remain in their transactions until this coordinator releases
# them. Advisory markers and observed PostgreSQL lock waits establish the order;
# no sleep duration is used to decide whether either writer reached its lock.
external_start_session() {
  local task_label="$1" task_sql="$2" task_fd
  local task_fifo="$TASK_LOG_DIR/external-$task_label.fifo"
  mkfifo "$task_fifo"
  psql_local -At < "$task_fifo" > "$TASK_LOG_DIR/external-$task_label.log" 2>&1 &
  TASK_EXTERNAL_PIDS["$task_label"]=$!
  exec {task_fd}> "$task_fifo"
  TASK_EXTERNAL_FDS["$task_label"]="$task_fd"
  printf '%s\n' "\\set VERBOSITY verbose" "set statement_timeout='10s';" \
    "set idle_in_transaction_session_timeout='20s';" \
    "set application_name='external-race-$task_label';" "begin;" "$task_sql" >&"$task_fd"
}
external_send() {
  local task_label="$1" task_fd="${TASK_EXTERNAL_FDS[$1]}"
  printf '%s\n' "$2" >&"$task_fd"
}
external_wait_condition() {
  local task_query="$1" task_description="$2" task_label
  for task_attempt in $(seq 1 100); do
    if [ "$(psql_local -Atc "$task_query")" = t ]; then return; fi
    sleep 0.05
  done
  for task_label in "${!TASK_EXTERNAL_PIDS[@]}"; do cat "$TASK_LOG_DIR/external-$task_label.log" >&2; done
  echo "FAILED: external-import concurrency barrier: $task_description" >&2; exit 1
}
external_wait_marker() {
  external_wait_condition "select exists(select 1 from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database()) and objid=$1 and granted)" "marker $1"
}
external_wait_lock() {
  external_wait_condition "select exists(select 1 from pg_stat_activity where datname='$TASK_DB_NAME' and application_name='external-race-$1' and wait_event_type='Lock')" "$1 waits for a database lock"
}
external_finish() {
  local task_label="$1" task_fd="${TASK_EXTERNAL_FDS[$1]}" task_status=0
  external_send "$task_label" $'commit;\n\\q'
  exec {task_fd}>&-
  unset 'TASK_EXTERNAL_FDS[$task_label]'
  wait "${TASK_EXTERNAL_PIDS[$task_label]}" || task_status=$?
  unset 'TASK_EXTERNAL_PIDS[$task_label]'
  if [ "$task_status" -ne 0 ]; then cat "$TASK_LOG_DIR/external-$task_label.log" >&2; exit 1; fi
}
external_rejected() {
  local task_label="$1" task_fd="${TASK_EXTERNAL_FDS[$1]}" task_status=0
  exec {task_fd}>&-
  unset 'TASK_EXTERNAL_FDS[$task_label]'
  wait "${TASK_EXTERNAL_PIDS[$task_label]}" || task_status=$?
  unset 'TASK_EXTERNAL_PIDS[$task_label]'
  if [ "$task_status" -eq 0 ] || ! rg -q '42501.*Somente administradores e gestores' "$TASK_LOG_DIR/external-$task_label.log"; then
    cat "$TASK_LOG_DIR/external-$task_label.log" >&2; exit 1
  fi
}
TASK_EXTERNAL_WS="$(psql_local -Atc "select test.value('external_ws_a')")"
TASK_EXTERNAL_ADMIN="00000000-0000-0000-0000-000000000140"
TASK_EXTERNAL_MANAGER="00000000-0000-0000-0000-000000000141"
TASK_EXTERNAL_CLOSER="00000000-0000-0000-0000-000000000142"
TASK_EXTERNAL_AUTH="set local role authenticated; select set_config('request.jwt.claim.sub','$TASK_EXTERNAL_ADMIN',true);"
TASK_EXTERNAL_CLOSER_AUTH="set local role authenticated; select set_config('request.jwt.claim.sub','$TASK_EXTERNAL_CLOSER',true);"

external_start_session same-a "$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(test.value('external_race_rows')::jsonb)->>'imported'='1','external: concurrent first batch imports one contact');
select pg_advisory_xact_lock(637201);"
external_wait_marker 637201
external_start_session same-b "$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(jsonb_build_array(test.external_record('concurrent-external-second',1,'{\"email\":\"external-race@example.test\"}')))->>'skipped'='1','external: concurrent second file skips existing contact');
select pg_advisory_xact_lock(637202);"
external_wait_lock same-b
external_finish same-a
external_wait_marker 637202
external_finish same-b
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_EXTERNAL_WS' and data->>'email'='external-race@example.test'),'external: concurrent different row keys create one contact');" >/dev/null
echo 'Concurrent external-import deduplication test passed.'

external_start_session manual-insert-a "$TASK_EXTERNAL_CLOSER_AUTH
insert into public.leads(workspace_id,id,owner_id,data) values('$TASK_EXTERNAL_WS','external-manual-insert-race','$TASK_EXTERNAL_CLOSER',
  test.lead('external-manual-insert-race')||'{\"email\":\"external-manual-race@example.test\",\"notes\":\"Keep manual note\"}');
select pg_advisory_xact_lock(637203);"
external_wait_marker 637203
external_start_session manual-insert-b "$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(test.value('external_manual_race_rows')::jsonb)->>'skipped'='1','external: import waiting on manual insert skips committed duplicate');
select pg_advisory_xact_lock(637204);"
external_wait_lock manual-insert-b
external_finish manual-insert-a
external_wait_marker 637204
external_finish manual-insert-b
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_EXTERNAL_WS' and data->>'email'='external-manual-race@example.test'),'external: manual insert and import create one contact');
select test.ok((select data->>'notes'='Keep manual note' from public.leads where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-insert-race'),'external: duplicate import preserves manual data');" >/dev/null
echo 'Concurrent manual-insert external-import test passed.'

psql_local -Atc "insert into public.leads(workspace_id,id,owner_id,data) values('$TASK_EXTERNAL_WS','external-manual-update-race','$TASK_EXTERNAL_CLOSER',
  test.lead('external-manual-update-race')||'{\"email\":\"external-before-update@example.test\"}');" >/dev/null
external_start_session manual-update-a "$TASK_EXTERNAL_CLOSER_AUTH
update public.leads set data=data||'{\"email\":\"external-after-update@example.test\"}' where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-update-race';
select pg_advisory_xact_lock(637205);"
external_wait_marker 637205
external_start_session manual-update-b "$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(jsonb_build_array(test.external_record('concurrent-updated-contact',1,'{\"email\":\"external-after-update@example.test\"}')))->>'skipped'='1','external: import observes committed manual email after workspace wait');
select pg_advisory_xact_lock(637206);"
external_wait_lock manual-update-b
external_finish manual-update-a
external_wait_marker 637206
external_finish manual-update-b
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_EXTERNAL_WS' and data->>'email'='external-after-update@example.test'),'external: manual update and import preserve one current contact');" >/dev/null
echo 'Concurrent manual-update external-import test passed.'

# Opposite-order regression: a direct editor already owns the duplicate lead,
# then requests the workspace while the importer owns it. Provenance insertion
# must never acquire a foreign-key lock on that existing lead.
external_start_session row-edit-a "$TASK_EXTERNAL_CLOSER_AUTH
select id from public.leads where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-update-race' for update;
select pg_advisory_xact_lock(637207);"
external_wait_marker 637207
external_start_session row-edit-b "select id from public.workspaces where id='$TASK_EXTERNAL_WS' for update;
select pg_advisory_xact_lock(637208);
$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(jsonb_build_array(test.external_record('concurrent-row-edit',1,'{\"email\":\"external-after-update@example.test\"}')))->>'skipped'='1','external: duplicate ledger writes without locking a manually held lead');
select pg_advisory_xact_lock(637209);"
external_wait_marker 637208
external_send row-edit-a "update public.leads set data=data||'{\"notes\":\"Row-first edit preserved\"}' where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-update-race'; select pg_advisory_xact_lock(637210);"
external_wait_lock row-edit-a
external_wait_marker 637209
external_finish row-edit-b
external_wait_marker 637210
external_finish row-edit-a
psql_local -Atc "select test.ok((select data->>'notes'='Row-first edit preserved' from public.leads where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-update-race'),'external: row-first manual edit and duplicate import finish without deadlock');" >/dev/null
echo 'Concurrent lead-row edit external-import test passed.'

external_start_session row-delete-a "$TASK_EXTERNAL_AUTH
select id from public.leads where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-update-race' for update;
select pg_advisory_xact_lock(637211);"
external_wait_marker 637211
external_start_session row-delete-b "select id from public.workspaces where id='$TASK_EXTERNAL_WS' for update;
select pg_advisory_xact_lock(637212);
$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(jsonb_build_array(test.external_record('concurrent-row-delete',1,'{\"email\":\"external-after-update@example.test\"}')))->>'skipped'='1','external: duplicate import finishes while a future deleter owns the lead');
select pg_advisory_xact_lock(637213);"
external_wait_marker 637212
external_send row-delete-a "delete from public.leads where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-update-race'; select pg_advisory_xact_lock(637214);"
external_wait_lock row-delete-a
external_wait_marker 637213
external_finish row-delete-b
external_wait_marker 637214
external_finish row-delete-a
psql_local -Atc "select test.ok(not exists(select 1 from public.leads where workspace_id='$TASK_EXTERNAL_WS' and id='external-manual-update-race'),'external: row-first delete and duplicate import finish without deadlock');
select test.ok(not exists(select 1 from private.external_import_keys where workspace_id='$TASK_EXTERNAL_WS' and lead_id='external-manual-update-race'),'external: deletion removes every provenance hash registered by concurrent duplicate import');" >/dev/null
echo 'Concurrent lead-row delete external-import test passed.'

# A new integration exists only in this disposable database. Neither its token
# nor its response is printed; the service RPC receives its digest internally.
psql_local <<SQL >/dev/null
begin;
$TASK_EXTERNAL_AUTH
insert into test.context values('external_inbound_race_created',public.create_inbound_integration('$TASK_EXTERNAL_WS','Import race local','Import race',
  test.value('external_stage_a')::uuid,'$TASK_EXTERNAL_CLOSER','{"name":"name","email":"email"}')::text);
insert into test.context values('external_inbound_race_hash',test.external_hash(test.value('external_inbound_race_created')::jsonb->>'token'));
commit;
SQL
TASK_EXTERNAL_INBOUND_HASH="$(psql_local -Atc "select test.value('external_inbound_race_hash')")"
external_start_session inbound-a "set local role service_role;
select public.receive_inbound_lead('$TASK_EXTERNAL_INBOUND_HASH',gen_random_uuid(),'{\"name\":\"Inbound local race\",\"email\":\"external-inbound-race@example.test\"}')->>'status' as external_received_status \\gset
reset role;
select test.ok(:'external_received_status'='created','external: inbound writer creates contact before waiting import');
select pg_advisory_xact_lock(637215);"
external_wait_marker 637215
external_start_session inbound-b "$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(test.value('external_inbound_race_rows')::jsonb)->>'skipped'='1','external: import waiting on inbound skips committed contact');
select pg_advisory_xact_lock(637216);"
external_wait_lock inbound-b
external_finish inbound-a
external_wait_marker 637216
external_finish inbound-b
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_EXTERNAL_WS' and data->>'email'='external-inbound-race@example.test'),'external: inbound and import preserve one contact');" >/dev/null
echo 'Concurrent inbound external-import test passed.'

external_start_session revoke-a "$TASK_EXTERNAL_AUTH
select public.update_member('$TASK_EXTERNAL_WS','$TASK_EXTERNAL_MANAGER','manager',false);
select pg_advisory_xact_lock(637217);"
external_wait_marker 637217
external_start_session revoke-b "set local role authenticated; select set_config('request.jwt.claim.sub','$TASK_EXTERNAL_MANAGER',true);
select test.external_import(test.value('external_revoke_race_rows')::jsonb);"
external_wait_lock revoke-b
external_finish revoke-a
external_rejected revoke-b
psql_local -Atc "select test.ok(not exists(select 1 from public.leads where workspace_id='$TASK_EXTERNAL_WS' and data->>'email'='external-revocation@example.test'),'external: manager revoked while waiting cannot import');" >/dev/null
psql_local <<SQL >/dev/null
begin;
$TASK_EXTERNAL_AUTH
select public.update_member('$TASK_EXTERNAL_WS','$TASK_EXTERNAL_MANAGER','manager',true);
commit;
SQL
echo 'Concurrent membership-revocation external-import test passed.'

external_start_session legacy-a "$TASK_EXTERNAL_CLOSER_AUTH
select test.ok(public.import_leads('$TASK_EXTERNAL_WS',jsonb_build_array(test.lead('external-legacy-race')||'{\"email\":\"external-legacy-race@example.test\",\"notes\":\"Original JSON backup note\"}'),'$TASK_EXTERNAL_CLOSER')->>'imported'='1','external: existing JSON importer remains usable concurrently');
select pg_advisory_xact_lock(637218);"
external_wait_marker 637218
external_start_session legacy-b "$TASK_EXTERNAL_AUTH
select test.ok(test.external_import(jsonb_build_array(test.external_record('concurrent-legacy',1,'{\"email\":\"external-legacy-race@example.test\"}')))->>'skipped'='1','external: import waiting on legacy JSON skips committed duplicate');
select pg_advisory_xact_lock(637219);"
external_wait_lock legacy-b
external_finish legacy-a
external_wait_marker 637219
external_finish legacy-b
psql_local -Atc "select test.ok((select count(*)=1 from public.leads where workspace_id='$TASK_EXTERNAL_WS' and data->>'email'='external-legacy-race@example.test'),'external: legacy JSON and new import preserve one contact');
select test.ok((select data->>'notes'='Original JSON backup note' from public.leads where workspace_id='$TASK_EXTERNAL_WS' and id='external-legacy-race'),'external: external duplicate does not rewrite original JSON lead');" >/dev/null
echo 'Concurrent legacy-JSON external-import test passed.'
psql_local -Atc "select 'Total database assertions: ' || count(*) from test.results"
