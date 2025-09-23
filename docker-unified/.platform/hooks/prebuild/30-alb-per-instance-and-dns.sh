#!/usr/bin/env bash
set -uo pipefail

# Function to log errors and continue
log_error() {
    echo "ERROR: $1" >&2
    echo "WARNING: Continuing Beanstalk startup despite error in DNS/ALB setup" >&2
}

# Function to run commands with error handling
run_safe() {
    if ! "$@"; then
        log_error "Command failed: $*"
        return 1
    fi
    return 0
}

# ---- CONFIG / ENV ----
DOMAIN="${DOMAIN:-batch.paops.xyz}"
PRIVATE_ZONE_ID="${PRIVATE_ZONE_ID:-}"
PUBLIC_ZONE_ID="${PUBLIC_ZONE_ID:-}"
NAME_MODE="${NAME_MODE:-id}"             # id | ip
TG_PORT="${TG_PORT:-80}"
HEALTH_CHECK_PATH="${HEALTH_CHECK_PATH:-/health}"
TTL="${TTL:-60}"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
STATE_DIR="/var/eb-per-instance-routing"
mkdir -p "$STATE_DIR"

# ---- TOOLS ----
command -v jq >/dev/null || (yum install -y jq || (apt-get update && apt-get install -y jq))

# ---- METADATA ----
TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
md(){ curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/$1" ; }
IID=$(md meta-data/instance-id)
AZ=$(md meta-data/placement/availability-zone)
REGION="${AZ::-1}"
PRIV4=$(md meta-data/local-ipv4)
# PRIV6=$(md meta-data/local-ipv6s 2>/dev/null || true)
PRIV6=""
PUB4=$(md meta-data/public-ipv4 2>/dev/null || true)

# Discover this instance's VPC for private zone lookup
MAC=$(md meta-data/network/interfaces/macs/ | head -n1 | tr -d '/')
VPC_ID=$(md meta-data/network/interfaces/macs/$MAC/vpc-id)

# ---- Instance label / FQDN ----
if [[ "$NAME_MODE" == "ip" && -n "${PUB4:-}" ]]; then
  LABEL="ec2-${PUB4//./-}"
else
  LABEL="$IID"
fi
FQDN="$LABEL.$DOMAIN"

echo "$FQDN" > "$STATE_DIR/$LABEL.fqdn"

# ---- Discover EB ALB via ASG -> TG -> LB ----
ASG=$(aws autoscaling describe-auto-scaling-instances --region "$REGION" --instance-ids "$IID" \
        --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text)
TG_ARNS=$(aws autoscaling describe-load-balancer-target-groups --region "$REGION" --auto-scaling-group-name "$ASG" \
           --query 'LoadBalancerTargetGroups[].LoadBalancerTargetGroupARN' --output text)
PRIMARY_TG_ARN=$(echo "$TG_ARNS" | awk '{print $1}')
read -r VPC_ID_FROM_TG ALB_ARN <<<"$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$PRIMARY_TG_ARN" \
  --query 'TargetGroups[0].[VpcId,LoadBalancerArns[0]]' --output text)"
# prefer VPC from TG if present
if [[ -n "$VPC_ID_FROM_TG" && "$VPC_ID_FROM_TG" != "None" ]]; then VPC_ID="$VPC_ID_FROM_TG"; fi
LISTENERS_JSON=$(aws elbv2 describe-listeners --region "$REGION" --load-balancer-arn "$ALB_ARN")
LISTENER_ARNS=($(echo "$LISTENERS_JSON" | jq -r '.Listeners[].ListenerArn'))
# Get ALB DNS + CanonicalHostedZoneId for alias records
read -r ALB_DNS_NAME ALB_ZONE_ID <<<"$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].[DNSName,CanonicalHostedZoneId]' --output text)"

# ---- Resolve Route 53 zone IDs from DOMAIN if not provided ----
ZONE_NAME="${DOMAIN%.}."  # ensure trailing dot
if [[ -z "$PUBLIC_ZONE_ID" || "$PUBLIC_ZONE_ID" == "None" ]]; then
  PUBLIC_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE_NAME" \
    --query 'HostedZones[?Name==`'"$ZONE_NAME"'` && Config.PrivateZone==`false`][0].Id' --output text | sed 's|/hostedzone/||') || true
fi
if [[ -z "$PRIVATE_ZONE_ID" || "$PRIVATE_ZONE_ID" == "None" ]]; then
  # Prefer zones actually associated to this VPC
  PRIVATE_ZONE_ID=$(aws route53 list-hosted-zones-by-vpc --vpc-id "$VPC_ID" --vpc-region "$REGION" \
    --query 'HostedZoneSummaries[?Name==`'"$ZONE_NAME"'`][0].HostedZoneId' --output text 2>/dev/null || true)
  if [[ -z "$PRIVATE_ZONE_ID" || "$PRIVATE_ZONE_ID" == "None" ]]; then
    PRIVATE_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE_NAME" \
      --query 'HostedZones[?Name==`'"$ZONE_NAME"'` && Config.PrivateZone==`true`][0].Id' --output text | sed 's|/hostedzone/||') || true
  fi
fi

if [[ -z "$PRIVATE_ZONE_ID" || -z "$PUBLIC_ZONE_ID" || "$PRIVATE_ZONE_ID" == "None" || "$PUBLIC_ZONE_ID" == "None" ]]; then
  log_error "Could not resolve PRIVATE_ZONE_ID/PUBLIC_ZONE_ID for $ZONE_NAME"
  echo "Skipping DNS setup - continuing with Beanstalk startup"
  exit 0
fi

echo "$PRIVATE_ZONE_ID" > "$STATE_DIR/$LABEL.private_zone"
echo "$PUBLIC_ZONE_ID"  > "$STATE_DIR/$LABEL.public_zone"

# ---- Dual‑zone DNS ----
# Private zone: A (+ AAAA if present) to PRIVATE IPs
PRIV_JSON="$WORKDIR/private.json"
cat >"$PRIV_JSON" <<JSON
{
  "Comment": "UPSERT private A/AAAA for $FQDN",
  "Changes": [
    {"Action":"UPSERT","ResourceRecordSet":{"Name":"$FQDN","Type":"A","TTL":$TTL,"ResourceRecords":[{"Value":"$PRIV4"}]}}
  ]
}
JSON
if [[ -n "${PRIV6:-}" ]]; then
  jq --arg n "$FQDN" --arg v "$PRIV6" --argjson ttl $TTL \
     '.Changes += [{Action:"UPSERT",ResourceRecordSet:{Name:$n,Type:"AAAA",TTL:$ttl,ResourceRecords:[{Value:$v}]}}]' \
     "$PRIV_JSON" > "$PRIV_JSON.2" && mv "$PRIV_JSON.2" "$PRIV_JSON"
fi

echo "**********************************************************************"
cat "$PRIV_JSON"
echo "**********************************************************************"
if run_safe aws route53 change-resource-record-sets --hosted-zone-id "$PRIVATE_ZONE_ID" --change-batch "file://$PRIV_JSON"; then
    echo "**********************************************************************"
    echo "private" > "$STATE_DIR/$LABEL.private"
else
    log_error "Failed to update DNS records, continuing without DNS setup"
fi

# Public zone: SKIPPED — using wildcard alias (*.batch.paops.xyz -> ALB).

# Nice‑to‑have hostname for logs
hostnamectl set-hostname "$FQDN" || true
grep -q "$FQDN" /etc/hosts || echo "127.0.0.1  $FQDN ${FQDN%%.*}" >> /etc/hosts

# ---- Create/ensure per‑instance Target Group ----
TG_NAME="tg-${LABEL}"
if run_safe aws elbv2 describe-target-groups --region "$REGION" --names "$TG_NAME" >/dev/null 2>&1; then
    EXISTING=$(aws elbv2 describe-target-groups --region "$REGION" --names "$TG_NAME" 2>/dev/null || true)
    if [[ -z "$EXISTING" || "$(echo "$EXISTING" | jq '.TargetGroups | length')" == "0" ]]; then
        if run_safe aws elbv2 create-target-group --region "$REGION" --name "$TG_NAME" \
            --protocol HTTP --port "$TG_PORT" --target-type instance --vpc-id "$VPC_ID" \
            --health-check-protocol HTTP --health-check-path "$HEALTH_CHECK_PATH" --matcher HttpCode=200-399 > /tmp/tg_create.json; then
            TG_ARN=$(jq -r '.TargetGroups[0].TargetGroupArn' /tmp/tg_create.json)
        else
            log_error "Failed to create target group, continuing without ALB setup"
            exit 0
        fi
    else
        TG_ARN=$(echo "$EXISTING" | jq -r '.TargetGroups[0].TargetGroupArn')
    fi

    if [[ -n "$TG_ARN" && "$TG_ARN" != "null" ]]; then
        if run_safe aws elbv2 register-targets --region "$REGION" --target-group-arn "$TG_ARN" --targets "Id=$IID,Port=$TG_PORT"; then
            echo "$TG_ARN" > "$STATE_DIR/$LABEL.tg"
        else
            log_error "Failed to register targets, continuing without ALB setup"
        fi
    fi
else
    log_error "Failed to check existing target groups, continuing without ALB setup"
    exit 0
fi

# ---- Create/ensure host‑header rules on each listener ----
if [[ -n "${TG_ARN:-}" && "$TG_ARN" != "null" && ${#LISTENER_ARNS[@]} -gt 0 ]]; then
    COND="$WORKDIR/cond.json"; ACT="$WORKDIR/act.json"
    printf '[{"Field":"host-header","HostHeaderConfig":{"Values":["%s"]}}]
' "$FQDN" > "$COND"
    printf '[{"Type":"forward","TargetGroupArn":"%s"}]
' "$TG_ARN" > "$ACT"

    : > "$STATE_DIR/$LABEL.rules"
    for L in "${LISTENER_ARNS[@]}"; do
        if run_safe aws elbv2 describe-rules --region "$REGION" --listener-arn "$L" > /tmp/rules.json; then
            RULE_ARN=$(jq -r --arg fqdn "$FQDN" '.Rules[] | select(.Conditions[]? | select(.Field=="host-header") | .HostHeaderConfig.Values | index($fqdn)) | .RuleArn' /tmp/rules.json | head -n1)
            if [[ -n "${RULE_ARN:-}" && "$RULE_ARN" != "null" ]]; then
                if run_safe aws elbv2 modify-rule --region "$REGION" --rule-arn "$RULE_ARN" --actions "file://$ACT"; then
                    echo "$RULE_ARN" >> "$STATE_DIR/$LABEL.rules"
                else
                    log_error "Failed to modify ALB rule $RULE_ARN"
                fi
            else
                USED=$(jq -r '.Rules[].Priority' /tmp/rules.json | grep -E '^[0-9]+$' || true)
                PRIO=1000; while echo "$USED" | grep -qx "$PRIO"; do PRIO=$((PRIO+1)); done
                if run_safe aws elbv2 create-rule --region "$REGION" --listener-arn "$L" --priority "$PRIO" --conditions "file://$COND" --actions "file://$ACT" > /tmp/create_rule.json; then
                    RULE_ARN=$(jq -r '.Rules[0].RuleArn' /tmp/create_rule.json)
                    echo "$RULE_ARN" >> "$STATE_DIR/$LABEL.rules"
                else
                    log_error "Failed to create ALB rule for listener $L"
                fi
            fi
        else
            log_error "Failed to describe rules for listener $L"
        fi
    done
else
    log_error "Missing TG_ARN or LISTENER_ARNS, skipping ALB rule creation"
fi