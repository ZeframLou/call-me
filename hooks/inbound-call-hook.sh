#!/bin/bash
# Inbound Call Stop Hook
# Checks for pending inbound calls and prompts Claude to respond

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

# Check if the call is stale (older than 5 minutes)
NOW=$(date +%s)
NOW_MS=$((NOW * 1000))
AGE=$((NOW_MS - TIMESTAMP))
if [[ $AGE -gt 300000 ]]; then
  # Call is stale, remove the file
  rm -f "$PENDING_FILE"
  exit 0
fi

# Remove the pending file so we don't prompt again
rm -f "$PENDING_FILE"

# Build the reason message
REASON="URGENT: There is an active inbound phone call waiting for your response!

Call ID: ${CALL_ID}
Caller: ${FROM}
They said: \"${TRANSCRIPT}\"

Use continue_call with call_id=\"${CALL_ID}\" to respond to them, or end_call to hang up."

# Output JSON to inject a prompt about the inbound call
jq -n --arg reason "$REASON" '{"decision": "block", "reason": $reason}'
