#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-batch.paops.xyz}"
PRIVATE_ZONE_ID="${PRIVATE_ZONE_ID:-}"
PUBLIC_ZONE_ID="${PUBLIC_ZONE_ID:-}"
NAME_MODE="${NAME_MODE:-id}"
TTL="${TTL:-60}"

STATE_DIR="/var/eb-per-instance-routing"

TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
md(){ curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/$1" ; }
IID=$(md meta-data/instance-id)
AZ=$(md meta-data/placement/availability-zone)
REGION="${AZ::-1}"
PRIV4=$(md meta-data/local-ipv4)
PRIV6=$(md meta-data/local-ipv6s 2>/dev/null || true)
PUB4=$(md meta-data/public-ipv4 2>/dev/null || true)

# VPC id for private zone lookup
MAC=$(md meta-data/network/interfaces/macs/ | head -n1 | tr -d '/')
VPC_ID=$(md meta-data/network/interfaces/macs/$MAC/vpc-id)

# reconstruct label/FQDN
if [[ -f "$STATE_DIR/$IID.fqdn" ]]; then
  FQDN=$(cat "$STATE_DIR/$IID.fqdn")
else
  if [[ "$NAME_MODE" == "ip" && -n "${PUB4:-}" ]]; then
    LABEL="ec2-${PUB4//./-}"
  else
    LABEL="$IID"
  fi
  FQDN="$LABEL.$DOMAIN"
fi

# ---- Resolve zone IDs if not provided (mirror postdeploy) ----
ZONE_NAME="${DOMAIN%.}."
if [[ -z "$PUBLIC_ZONE_ID" || "$PUBLIC_ZONE_ID" == "None" ]]; then
  PUBLIC_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE_NAME" \
    --query 'HostedZones[?Name==`'"$ZONE_NAME"'` && Config.PrivateZone==`false`][0].Id' --output text | sed 's|/hostedzone/||') || true
fi
if [[ -z "$PRIVATE_ZONE_ID" || "$PRIVATE_ZONE_ID" == "None" ]]; then
  PRIVATE_ZONE_ID=$(aws route53 list-hosted-zones-by-vpc --vpc-id "$VPC_ID" --vpc-region "$REGION" \
    --query 'HostedZoneSummaries[?Name==`'"$ZONE_NAME"'`][0].HostedZoneId' --output text 2>/dev/null || true)
  if [[ -z "$PRIVATE_ZONE_ID" || "$PRIVATE_ZONE_ID" == "None" ]]; then
    PRIVATE_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE_NAME" \
      --query 'HostedZones[?Name==`'"$ZONE_NAME"'` && Config.PrivateZone==`true`][0].Id' --output text | sed 's|/hostedzone/||') || true
  fi
fi

# ---- Locate ALB and its DNS/zone id ----
TG_ARN=""; [[ -f "$STATE_DIR/$IID.tg" ]] && TG_ARN=$(cat "$STATE_DIR/$IID.tg" || true)
if [[ -z "$TG_ARN" || "$TG_ARN" == "None" ]]; then
  TG_NAME="tg-${FQDN%%.$DOMAIN}"
  TG_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --names "$TG_NAME" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
fi
ALB_ARN=""
if [[ -n "$TG_ARN" && "$TG_ARN" != "None" ]]; then
  ALB_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" \
    --query 'TargetGroups[0].LoadBalancerArns[0]' --output text 2>/dev/null || true)
fi
if [[ -z "$ALB_ARN" || "$ALB_ARN" == "None" ]]; then
  ASG=$(aws autoscaling describe-auto-scaling-instances --region "$REGION" --instance-ids "$IID" \
          --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text 2>/dev/null || true)
  if [[ -n "$ASG" && "$ASG" != "None" ]]; then
    TG_ARNS=$(aws autoscaling describe-load-balancer-target-groups --region "$REGION" --auto-scaling-group-name "$ASG" \
               --query 'LoadBalancerTargetGroups[].LoadBalancerTargetGroupARN' --output text 2>/dev/null || true)
    PRIMARY_TG_ARN=$(echo "$TG_ARNS" | awk '{print $1}')
    if [[ -n "$PRIMARY_TG_ARN" ]]; then
      ALB_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$PRIMARY_TG_ARN" \
        --query 'TargetGroups[0].LoadBalancerArns[0]' --output text 2>/dev/null || true)
    fi
  fi
fi

ALB_DNS_NAME=""; ALB_ZONE_ID=""
if [[ -n "$ALB_ARN" && "$ALB_ARN" != "None" ]]; then
  read -r ALB_DNS_NAME ALB_ZONE_ID <<<"$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arns "$ALB_ARN" \
    --query 'LoadBalancers[0].[DNSName,CanonicalHostedZoneId]' --output text 2>/dev/null || true)"
fi

# ---- Delete ALB rules ----
if [[ -s "$STATE_DIR/$IID.rules" ]]; then
  while read -r RARN; do [[ -n "$RARN" ]] && aws elbv2 delete-rule --region "$REGION" --rule-arn "$RARN" || true; done < "$STATE_DIR/$IID.rules"
else
  if [[ -n "$TG_ARN" && "$TG_ARN" != "None" && -n "$ALB_ARN" && "$ALB_ARN" != "None" ]]; then
    LISTENERS=$(aws elbv2 describe-listeners --region "$REGION" --load-balancer-arn "$ALB_ARN" --query 'Listeners[].ListenerArn' --output text)
    for L in $LISTENERS; do
      R=$(aws elbv2 describe-rules --region "$REGION" --listener-arn "$L" \
        | jq -r --arg fqdn "$FQDN" '.Rules[] | select(.Conditions[]? | select(.Field=="host-header") | .HostHeaderConfig.Values | index($fqdn)) | .RuleArn')
      for RARN in $R; do aws elbv2 delete-rule --region "$REGION" --rule-arn "$RARN" || true; done
    done
  fi
fi

# ---- Deregister & delete TG ----
if [[ -n "$TG_ARN" && "$TG_ARN" != "None" ]]; then
  aws elbv2 deregister-targets --region "$REGION" --target-group-arn "$TG_ARN" --targets "Id=$IID" || true
  aws elbv2 delete-target-group --region "$REGION" --target-group-arn "$TG_ARN" || true
fi

# ---- Remove dual‑zone DNS ----
# Private per‑instance record only (public is handled by wildcard alias)
if [[ -n "$PRIVATE_ZONE_ID" && "$PRIVATE_ZONE_ID" != "None" ]]; then
  DEL_PRIV="$STATE_DIR/del-private.json"
  cat >"$DEL_PRIV" <<JSON
  {"Changes":[{"Action":"DELETE","ResourceRecordSet":{"Name":"$FQDN","Type":"A","TTL":$TTL,"ResourceRecords":[{"Value":"$PRIV4"}]}}]}
JSON
  if [[ -n "${PRIV6:-}" ]]; then
    jq --arg n "$FQDN" --arg v "$PRIV6" '.Changes += [{"Action":"DELETE","ResourceRecordSet":{"Name":$n,"Type":"AAAA","TTL":60,"ResourceRecords":[{"Value":$v}]}}]' "$DEL_PRIV" > "$DEL_PRIV.2" && mv "$DEL_PRIV.2" "$DEL_PRIV"
  fi
  aws route53 change-resource-record-sets --hosted-zone-id "$PRIVATE_ZONE_ID" --change-batch "file://$DEL_PRIV" || true
fi

# Cleanup state
rm -f "$STATE_DIR/$IID."{fqdn,tg,public,rules,private,private_zone,public_zone} || true