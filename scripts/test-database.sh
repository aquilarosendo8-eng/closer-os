#!/usr/bin/env bash
# Run only against a disposable local Docker database, never a configured Supabase project.
set -euo pipefail
TASK_DB_CONTAINER="${CLOSER_OS_TEST_DB_CONTAINER:-closer-os-db-tests}"
TASK_DB_NAME="closer_os_test_${$}_$(date +%s)"
TASK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_LOG_DIR="$(mktemp -d /tmp/closer-os-db-test.XXXXXX)"
TASK_CREATED_CONTAINER=false
cleanup() {
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
    if docker exec "$TASK_DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
docker exec "$TASK_DB_CONTAINER" createdb -U postgres "$TASK_DB_NAME"
psql_local() { docker exec -i "$TASK_DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$TASK_DB_NAME" "$@"; }
psql_local < "$TASK_REPO_ROOT/supabase/tests/auth-stub.sql" >/dev/null
psql_local < "$TASK_REPO_ROOT/supabase/migrations/202610070001_closer_os.sql" >/dev/null
if ! psql_local < "$TASK_REPO_ROOT/supabase/tests/rls.sql" > "$TASK_LOG_DIR/rls.log" 2>&1; then
  cat "$TASK_LOG_DIR/rls.log" >&2; exit 1
fi
sed -n '/SQL assertions passed:/p' "$TASK_LOG_DIR/rls.log"
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
psql_local -Atc "select 'Total database assertions: ' || count(*) from test.results"
