#!/usr/bin/env bash
#
# Create / refresh a read-only PostgreSQL role for local GUI access.
#
# Idempotent: safe to re-run. Dynamically grants SELECT on every non-system
# schema currently present in the DB, so re-running after a new feature's
# migration lands (e.g. portfolio / marketdata schema first appears) auto-
# extends coverage — no edit needed.
#
# Access path — B2 zero-downtime SSH tunnel (does NOT recreate the pg
# container; forwards a local port straight to the container bridge IP):
#   local$ ssh -fN mbw-staging          # ~/.ssh/config: LocalForward 15432 -> <pg-ip>:5432
#   GUI   -> host=127.0.0.1 port=15432 db=mbw user=<ROLE_NAME>
#   stop  -> pkill -f "ssh -fN mbw-staging"
# Container IP can change if postgres is recreated; re-check & update the
# LocalForward line with:
#   docker compose -f docker-compose.tight.yml --env-file .env.production \
#     ps -q postgres | xargs docker inspect \
#     -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
#
# Runs on the production ECS host. The pg container's local socket is trust-auth,
# so psql -U <super> needs no password:
#   ./ops/bin/setup-pg-readonly-tunnel.sh
#
# Env overrides:
#   ROLE_NAME       read-only role name                      (default ro_viewer)
#   RESET_PASSWORD  =1 to rotate the password on an existing role (default off)
#   COMPOSE_FILE    compose file        (default /home/admin/no-vain-years-mono/docker-compose.tight.yml)
#   ENV_FILE        env file            (default /home/admin/no-vain-years-mono/.env.production)
#
# First run prints the generated password — capture it for the GUI. Later runs
# preserve the existing password (so the GUI keeps working) unless RESET_PASSWORD=1.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/home/admin/no-vain-years-mono/docker-compose.tight.yml}"
ENV_FILE="${ENV_FILE:-/home/admin/no-vain-years-mono/.env.production}"
ROLE_NAME="${ROLE_NAME:-ro_viewer}"
RESET_PASSWORD="${RESET_PASSWORD:-0}"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: $ENV_FILE not found" >&2
    exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
DB_SUPER="${DB_USERNAME:-mbw}"

psql_super() {
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
        exec -T postgres psql -U "$DB_SUPER" -d mbw -v ON_ERROR_STOP=1 "$@"
}

# Non-system schemas actually present in the DB right now.
mapfile -t SCHEMAS < <(psql_super -tAc \
    "SELECT schema_name FROM information_schema.schemata \
     WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'")

if [[ "${#SCHEMAS[@]}" -eq 0 ]]; then
    echo "Error: no application schemas found in DB" >&2
    exit 1
fi
echo "[$(date -Iseconds)] schemas present: ${SCHEMAS[*]}"

ROLE_EXISTS=$(psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE_NAME'")

NEW_PW=""
if [[ "$ROLE_EXISTS" != "1" ]]; then
    NEW_PW=$(openssl rand -hex 16)
    psql_super -c "CREATE ROLE $ROLE_NAME LOGIN PASSWORD '$NEW_PW'"
    echo "[$(date -Iseconds)] created role $ROLE_NAME"
elif [[ "$RESET_PASSWORD" == "1" ]]; then
    NEW_PW=$(openssl rand -hex 16)
    psql_super -c "ALTER ROLE $ROLE_NAME LOGIN PASSWORD '$NEW_PW'"
    echo "[$(date -Iseconds)] rotated password for $ROLE_NAME"
else
    echo "[$(date -Iseconds)] role $ROLE_NAME exists; password preserved (RESET_PASSWORD=1 to rotate)"
fi

psql_super -c "GRANT CONNECT ON DATABASE mbw TO $ROLE_NAME"

for s in "${SCHEMAS[@]}"; do
    psql_super -c "GRANT USAGE ON SCHEMA \"$s\" TO $ROLE_NAME"
    psql_super -c "GRANT SELECT ON ALL TABLES IN SCHEMA \"$s\" TO $ROLE_NAME"
    psql_super -c "ALTER DEFAULT PRIVILEGES IN SCHEMA \"$s\" GRANT SELECT ON TABLES TO $ROLE_NAME"
done

# Belt-and-suspenders: force every transaction read-only + browse all schemas.
psql_super -c "ALTER ROLE $ROLE_NAME SET default_transaction_read_only = on"
SEARCH_PATH=$(IFS=,; echo "${SCHEMAS[*]}")
psql_super -c "ALTER ROLE $ROLE_NAME SET search_path = $SEARCH_PATH"

echo "[$(date -Iseconds)] SELECT granted across ${#SCHEMAS[@]} schema(s)"
if [[ -n "$NEW_PW" ]]; then
    echo "=================================================="
    echo " ROLE:     $ROLE_NAME"
    echo " PASSWORD: $NEW_PW"
    echo " (capture now — not recoverable later)"
    echo "=================================================="
fi
