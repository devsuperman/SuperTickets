#!/bin/bash
# Runs inside LocalStack on startup (ready.d). Creates topic, queues, DLQs, filtered subscriptions.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
TOPIC=supertickets-events
A="awslocal --region $REGION"

TOPIC_ARN=$($A sns create-topic --name "$TOPIC" --query TopicArn --output text)

# create_consumer <queue> <dlq> <eventType>
create_consumer() {
  local queue=$1 dlq=$2 event=$3
  $A sqs create-queue --queue-name "$dlq" >/dev/null
  local dlq_arn
  dlq_arn=$($A sqs get-queue-attributes --queue-url "$($A sqs get-queue-url --queue-name "$dlq" --query QueueUrl --output text)" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)

  local attrs
  attrs=$(printf '{"VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' "$dlq_arn")
  $A sqs create-queue --queue-name "$queue" --attributes "$attrs" >/dev/null
  local url arn
  url=$($A sqs get-queue-url --queue-name "$queue" --query QueueUrl --output text)
  arn=$($A sqs get-queue-attributes --queue-url "$url" --attribute-names QueueArn --query Attributes.QueueArn --output text)

  $A sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$arn" \
    --attributes "{\"RawMessageDelivery\":\"true\",\"FilterPolicy\":\"{\\\"eventType\\\":[\\\"$event\\\"]}\"}" >/dev/null
  echo "created $queue (dlq $dlq) <- $event"
}

create_consumer payment-queue payment-dlq OrderCreated
create_consumer notification-queue notification-dlq PaymentSucceeded
echo "init-aws done: $TOPIC_ARN"
