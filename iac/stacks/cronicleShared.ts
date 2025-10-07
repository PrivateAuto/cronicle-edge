import  { Vpc, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { CfnInstanceProfile, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { StackContext, use } from "sst/constructs";
import { getLastestDockerStack } from "./eb-utils";
import { getVPCByTags, makeIAMRole } from "./utils";
import { EBProps } from "./ElasticBeanstalkDocker";
import { cronicleEFSStack } from "./cronicleEFSStack";
import { VPC_NAME, pkgJson } from "../sst.config";

export async function cronicleShared(
  ctx: StackContext //,
  // vpcName: string = VPC_NAME
) {
  const stack: any = ctx.stack;
  const fileSystem = use(cronicleEFSStack);

  const { region, stage, name: appName } = ctx.app;
  // const versionId = pkgJson.version;
  const solutionStackName = await getLastestDockerStack(region);


  // const vpc = getVPCByTags(stack, region, { Name: vpcName, 'pa-use' :'pa-network' });
  const vpc = Vpc.fromLookup(stack, "pa-vpc", { vpcId: "vpc-0aba33d47e35cde06", region });
  const instanceProfileName = `${appName}-instance-profile`;

  const securityGroups = [
    SecurityGroup.fromLookupByName(stack, "out", "allAllowOut", vpc),
    SecurityGroup.fromLookupByName(stack, "v4", "allAllowV4From10", vpc),
  ];

  // IAM Role for EB Instances with CloudWatch Logs and EFS access
  const ebInstanceRole = makeIAMRole(
    stack,
    `${appName}-instance`,
    ["ec2.amazonaws.com"],
    [
      "CloudWatchLogsFullAccess",
      "AmazonElasticFileSystemClientReadWriteAccess",
      "AmazonEC2ContainerRegistryReadOnly",
    ],
    [
      "pa-s3FullAccess-policy",
      "pa-ssmAccess-policy",
      "pa-apiBasicAccess-policy"
    ],
    [
      new PolicyStatement({
        actions: ["elasticbeanstalk:PutInstanceStatistics"],
        resources: [
          `arn:aws:elasticbeanstalk:${region}:${ctx.app.account}:application/*`,
          `arn:aws:elasticbeanstalk:${region}:${ctx.app.account}:environment/*`,
        ],
      }),
      new PolicyStatement({
        actions: [
          "sns:ListSubscriptions",
          "sns:ListSubscriptionsByTopic",
          "sns:Publish",
          "sns:Subscribe",
          "sns:ConfirmSubscription",
          "sns:SetSubscriptionAttributes",
          "sns:ListTopics",
          "sns:Unsubscribe",
        ],
        resources: [`arn:aws:sns:${region}:${ctx.app.account}:*`, "*"],
      }),

      // this is for the zuto-route dual zone configuration
      new PolicyStatement({
        actions: [
          "elasticloadbalancing:CreateTargetGroup",
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetHealth",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:ModifyRule",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:SetRulePriorities",
        ],
        resources: ["*"],
      }),
      new PolicyStatement({
        actions: [
          "autoscaling:DescribeAutoScalingInstances",
          "autoscaling:DescribeLoadBalancerTargetGroups",
        ],
        resources: ["*"],
      }),
      new PolicyStatement({
        actions: ["route53:ChangeResourceRecordSets"],
        resources: ["arn:aws:route53:::hostedzone/*"],
      }),
      new PolicyStatement({
        actions: [
          "route53:ListHostedZonesByName",
          "route53:ListHostedZonesByVPC",
          "route53:GetHostedZone",
          "route53:GetChange",
          "route53:ListResourceRecordSets",
        ],
        resources: ["*"],
      }),
      new PolicyStatement({
        actions: [ "sts:AssumeRole" ],
        resources: [
          "arn:aws:iam::182399724557:role/pa-octopus-oidc-role",
          "arn:aws:iam::331322215907:role/pa-octopus-oidc-role"
        ],
      })
    ]
  );

  // instance profile
  const iProf = new CfnInstanceProfile(stack, `${appName}-instance-profile`, {
    instanceProfileName,
    roles: [ebInstanceRole.roleName],
  });

  console.log(`Role: ${ebInstanceRole.roleName} - Profile: ${instanceProfileName} / ${iProf.instanceProfileName}`);

  // EB Common Config
  const ebProps: EBProps = {
    stage,
    region,
    instanceType: "t3.small",
    solutionStackName,
    vpc,
    securityGroups,
    instanceProfileName: iProf.instanceProfileName || instanceProfileName,
    instanceRole: ebInstanceRole,
    environment: {
      TZ: "America/Chicago",
      EFS_ID: fileSystem.fileSystemId,
      DOMAIN: "batch.paops.xyz",
      PRIVATE_ZONE_ID: "Z02458833BN9S7SLE8J71",
      PUBLIC_ZONE_ID: "Z01514342XRAVNZ06MTDD",
      NAME_MODE: "id", // id or ip
      TG_PORT: "80",
      HEALTH_CHECK_PATH: "/health",
      TTL: "60",
    },
    options: {
      TZ: "America/Chicago",
      EFS_ID: fileSystem.fileSystemId,
    },
    publicIngress: [],
  };

  return {
    vpc,
    ebInstanceRole,
    securityGroups,
    ebProps,
  };
}
