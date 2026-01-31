#!/bin/bash
# Check for pending inbound calls on user prompt submit
# Injects a notice if there's an active call waiting

PENDING_FILE="/tmp/callme-pending-inbound.json"

# Check if pending call file exists
if [[ ! -f "$PENDING_FILE" ]]; then
  exit 0
fi

# Read the pending call info
CALL_INFO=$(cat "$PENDING_FILE")
CALL_ID=$(echo "$CALL_INFO" | jq -r '.callId')
FROM=$(echo "$CALL_INFO" | jq -r '.from')
TRANSCRIPT=$(echo "$CALL_INFO" | jq -r '.transcript')
TIMESTAMP=$(echo "$CALL_INFO" | jq -r '.timestamp')

# Check if the call is stale (older than 5 minutes = 300000ms)
NOW=$(date +%s)
NOW_MS=$((NOW * 1000))
AGE=$((NOW_MS - TIMESTAMP))
if [[ $AGE -gt 300000 ]]; then
  rm -f "$PENDING_FILE"
  exit 0
fi

# Don't remove the file - let Stop hook handle cleanup after Claude responds
# Just prepend context to the user's message

cat << EOF
[URGENT - ACTIVE PHONE CALL]
Someone is on the phone waiting for you to respond!

Call ID: $CALL_ID
Caller: $FROM
They said: "$TRANSCRIPT"

IMPORTANT: Before doing anything else, use continue_call with call_id="$CALL_ID" to respond to them!
---
EOF
