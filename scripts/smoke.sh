#!/usr/bin/env bash
# End-to-end smoke test for the Definition of done (tech-plan.md).
#   scripts/smoke.sh [BASE_URL] [--no-toggles]
# BASE_URL defaults to http://localhost:5173 (SPA proxy); env BASE_URL also works.
# --no-toggles skips the failure-toggle checks (they restart the Worker with
# docker compose, so they are local only).
# Env: ADMIN_API_KEY (default dev-admin-key), PAYMENT_RETRIES (default 6).
set -u

BASE_URL="${BASE_URL:-http://localhost:5173}"
TOGGLES=1
for a in "$@"; do
  case "$a" in
    --no-toggles) TOGGLES=0 ;;
    http*) BASE_URL="$a" ;;
    *) echo "usage: $0 [BASE_URL] [--no-toggles]" >&2; exit 2 ;;
  esac
done
BASE_URL="${BASE_URL%/}"
ADMIN_KEY="${ADMIN_API_KEY:-dev-admin-key}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
PASS=0; FAIL=0
cleanup() {
  rm -rf "$TMP"
  if [ "$TOGGLES" = 1 ] && [ "${WORKER_TOGGLED:-0}" = 1 ]; then
    (cd "$ROOT" && docker compose up -d --no-deps --no-build --force-recreate worker >/dev/null 2>&1)
  fi
}
trap cleanup EXIT

command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }

ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1${2:+ ($2)}"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

# req METHOD PATH [curl args...] -> sets CODE, BODY, HDRS (file)
req() {
  local m="$1" p="$2"; shift 2
  CODE=$(curl -sS -m 20 -X "$m" -D "$TMP/h" -o "$TMP/b" -w '%{http_code}' "$@" "$BASE_URL$p" 2>"$TMP/e") || CODE=000
  BODY=$(cat "$TMP/b" 2>/dev/null)
  HDRS=$(tr -d '\r' <"$TMP/h" 2>/dev/null)
}
hdr() { printf '%s\n' "$HDRS" | awk -F': ' -v k="$(printf '%s' "$1" | tr A-Z a-z)" 'tolower($1)==k{print $2}'; }
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; }
future() { date -u -d "+${1:-30} days" +%Y-%m-%dT%H:%M:%SZ; }

create_event() { # name total price
  req POST /admin/events -H "X-Api-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg n "$1" --arg s "$(future)" --argjson t "$2" --argjson p "${3:-10.00}" \
      '{name:$n,venue:"Smoke Arena",startsAt:$s,totalTickets:$t,price:$p}')"
}
order() { # key eventId qty
  req POST /orders -H "Idempotency-Key: $1" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$2" --argjson q "${3:-1}" '{eventId:$e,quantity:$q,customerEmail:"smoke@example.com"}')"
}
available() { req GET "/events/$1/availability"; printf '%s' "$BODY" | jq -r .available; }
# wait_order ID JQ_CONDITION [SECONDS] -> BODY holds last order
wait_order() {
  local end=$((SECONDS + ${3:-40}))
  while [ $SECONDS -lt $end ]; do
    req GET "/orders/$1"
    [ "$CODE" = 200 ] && printf '%s' "$BODY" | jq -e "$2" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

echo "Smoke test against $BASE_URL (toggles: $([ $TOGGLES = 1 ] && echo on || echo off))"
RUN="smoke-$(date +%s)-$RANDOM"

# 1. GET /events returns data
EV_JSON=""
create_event "$RUN main" 20 10.00
check "admin create event returns 201" "$CODE" 201
EID=$(printf '%s' "$BODY" | jq -r .id)
[ -n "$(hdr location)" ] && ok "create event sets Location" || bad "create event sets Location"
req POST /admin/events -H 'Content-Type: application/json' -d '{}'
check "admin without key returns 401" "$CODE" 401
req GET "/events?search=$(printf '%s' "$RUN main" | jq -sRr @uri)"
check "GET /events returns 200" "$CODE" 200
printf '%s' "$BODY" | jq -e --arg id "$EID" 'type=="array" and any(.[]; .id==$id)' >/dev/null \
  && ok "GET /events lists the new event" || bad "GET /events lists the new event" "$BODY"
req GET "/events"
printf '%s' "$BODY" | jq -e 'type=="array" and length>0' >/dev/null && ok "GET /events returns data" || bad "GET /events returns data"

# 2. Availability synced from Catalog -> Inventory
av=""; for _ in $(seq 1 10); do av=$(available "$EID"); [ "$av" = 20 ] && break; sleep 1; done
check "availability equals totalTickets" "$av" 20

# 3. Catalog cache hits from Redis
req GET "/events/$EID"; first=$(hdr x-cache)
req GET "/events/$EID"; second=$(hdr x-cache)
check "second GET /events/{id} is X-Cache HIT" "$second" HIT
req PUT "/admin/events/$EID" -H "X-Api-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$(future)" '{name:"smoke renamed",venue:"Smoke Arena",startsAt:$s,totalTickets:20,price:12.50}')"
check "admin update returns 200" "$CODE" 200
req GET "/events/$EID"; check "GET after update is X-Cache MISS" "$(hdr x-cache)" MISS
req GET "/events/$EID"; check "then HIT again" "$(hdr x-cache)" HIT
req GET "/events/$(uuid)"; check "unknown event returns 404" "$CODE" 404

# 4. Order completes end to end (OrderCreated -> payment -> PaymentSucceeded -> notification -> tickets)
PAID=""; QTY=2
for i in $(seq 1 "${PAYMENT_RETRIES:-6}"); do
  KEY="$RUN-order-$i"
  order "$KEY" "$EID" $QTY
  [ "$CODE" = 202 ] || { bad "POST /orders returns 202" "got $CODE $BODY"; break; }
  OID=$(printf '%s' "$BODY" | jq -r .id)
  wait_order "$OID" '.status!="pending"' 40 || { bad "order leaves pending" "$BODY"; break; }
  if printf '%s' "$BODY" | jq -e '.status=="paid"' >/dev/null; then PAID=$OID; break; fi
  echo "      (order $i cancelled by random payment failure, retrying)"
done
if [ -n "$PAID" ]; then
  ok "order reaches paid (payment handler via OrderCreated)"
  wait_order "$PAID" '.tickets|length==2' 40 && ok "tickets generated (notification handler via PaymentSucceeded)" \
    || bad "tickets generated" "$BODY"
  printf '%s' "$BODY" | jq -e '[.tickets[].number]==[1,2] and all(.tickets[]; .status=="valid")' >/dev/null \
    && ok "tickets numbered 1..quantity and valid" || bad "tickets numbered 1..quantity" "$BODY"
  order "$KEY" "$EID" $QTY
  [ "$CODE" = 202 ] && [ "$(printf '%s' "$BODY" | jq -r .id)" = "$PAID" ] \
    && ok "same Idempotency-Key returns the existing order" || bad "idempotent replay" "$CODE $BODY"
  av=$(available "$EID")
  check "stock decreased by reserved quantity" "$av" $((20 - QTY))
else
  bad "order reaches paid"
fi
req POST /orders -H 'Content-Type: application/json' -d "{\"eventId\":\"$EID\",\"quantity\":1,\"customerEmail\":\"a@b.com\"}"
check "POST /orders without key returns 400" "$CODE" 400
order "$RUN-bad" "$EID" 0
check "quantity 0 returns 400" "$CODE" 400
order "$RUN-404" "$(uuid)" 1
check "unknown event order returns 404" "$CODE" 404

# 5. Last-ticket race: two concurrent orders, one wins
create_event "$RUN race" 1 5.00
RID=$(printf '%s' "$BODY" | jq -r .id)
for _ in $(seq 1 10); do [ "$(available "$RID")" = 1 ] && break; sleep 1; done
( curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE_URL/orders" -H "Idempotency-Key: $RUN-race-a" -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"$RID\",\"quantity\":1,\"customerEmail\":\"a@example.com\"}" >"$TMP/ra" ) &
( curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE_URL/orders" -H "Idempotency-Key: $RUN-race-b" -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"$RID\",\"quantity\":1,\"customerEmail\":\"b@example.com\"}" >"$TMP/rb" ) &
wait
codes=$(cat "$TMP/ra" "$TMP/rb" | sort | tr '\n' ' ')
check "concurrent last-ticket orders: one 202, one 409" "$codes" "202 409 "

# 6. Failure toggles (local only)
if [ "$TOGGLES" = 1 ]; then
  compose_worker() { # env overrides as KEY=VAL...
    local f="$TMP/override.yml"
    { echo "services:"; echo "  worker:"; echo "    environment:"; for kv in "$@"; do echo "      ${kv%%=*}: \"${kv#*=}\""; done; } >"$f"
    (cd "$ROOT" && docker compose -f docker-compose.yml -f "$f" up -d --no-deps --no-build --force-recreate worker >/dev/null 2>&1)
    WORKER_TOGGLED=1; sleep 5
  }
  dlq_count() {
    (cd "$ROOT" && docker compose exec -T localstack awslocal sqs get-queue-attributes \
      --queue-url http://localhost:4566/000000000000/notification-dlq --attribute-names ApproximateNumberOfMessages) 2>/dev/null \
      | jq -r '.Attributes.ApproximateNumberOfMessages // "0"'
  }

  create_event "$RUN payfail" 5 5.00; FID=$(printf '%s' "$BODY" | jq -r .id)
  for _ in $(seq 1 10); do [ "$(available "$FID")" = 5 ] && break; sleep 1; done
  compose_worker Payment__FailureRate=1
  order "$RUN-pf" "$FID" 2; check "order accepted while payment is forced to fail" "$CODE" 202
  OID=$(printf '%s' "$BODY" | jq -r .id)
  wait_order "$OID" '.status=="cancelled"' 60 && ok "forced payment failure cancels the order" || bad "forced payment failure cancels the order" "$BODY"
  check "cancelReason is payment_failed" "$(printf '%s' "$BODY" | jq -r .cancelReason)" payment_failed
  av=""; for _ in $(seq 1 20); do av=$(available "$FID"); [ "$av" = 5 ] && break; sleep 1; done
  check "stock restored after payment failure" "$av" 5

  create_event "$RUN notiffail" 5 5.00; NID=$(printf '%s' "$BODY" | jq -r .id)
  for _ in $(seq 1 10); do [ "$(available "$NID")" = 5 ] && break; sleep 1; done
  compose_worker Payment__FailureRate=0 Demo__NotificationErrorRate=1
  before=$(dlq_count)
  order "$RUN-nf" "$NID" 1; check "order accepted while notification is forced to fail" "$CODE" 202
  OID=$(printf '%s' "$BODY" | jq -r .id)
  wait_order "$OID" '.status=="paid"' 60 && ok "order paid despite notification failure" || bad "order paid despite notification failure" "$BODY"
  echo "      (waiting for 5 receives x 30s visibility to reach notification-dlq, up to 240s)"
  after=$before; end=$((SECONDS + 240))
  while [ $SECONDS -lt $end ]; do after=$(dlq_count); [ "${after:-0}" -gt "${before:-0}" ] && break; sleep 10; done
  [ "${after:-0}" -gt "${before:-0}" ] && ok "forced notification failure reaches the DLQ" || bad "forced notification failure reaches the DLQ" "before=$before after=$after"

  # restore the normal Worker (also done by the exit trap)
  (cd "$ROOT" && docker compose up -d --no-deps --no-build --force-recreate worker >/dev/null 2>&1); WORKER_TOGGLED=0
else
  echo "SKIP  failure-toggle checks (--no-toggles)"
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" = 0 ]
