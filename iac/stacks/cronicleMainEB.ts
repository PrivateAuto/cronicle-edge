import { StackContext } from "sst/constructs";
import { Vpc, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { CfnInstanceProfile, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { ElasticBeanstalkDocker, EBProps } from "./ElasticBeanstalkDocker";
import { VPC_NAME, STACKNAME } from "../sst.config";
import { getLastestDockerStack } from "./eb-utils";
import { makeIAMRole, getAccountId } from "./utils";
import { configure, getCronicleEnvironmentVars } from "./env-configs";

// Cronicle constants
const CRONICLE_COMM_USE_HOSTNAMES = "1"; // Always use hostnames for server communication

export async function cronicleMainEB(ctx: StackContext, vpcName: string = VPC_NAME) {
  const stack: any = ctx.stack;

  // Get environment configuration
  const accountId = await getAccountId();
  const config = configure(accountId);

  // Shared infrastructure setup (previously in cronicleShared)
  const { region, stage, name: appName } = ctx.app;
  const solutionStackName = await getLastestDockerStack(region);
  const vpc = Vpc.fromLookup(stack, "VPC", { vpcName });
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
    [],
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
  new CfnInstanceProfile(stack, `${appName}-instance-profile`, {
    instanceProfileName,
    roles: [ebInstanceRole.roleName],
  });

  // EB Common Config
  const ebProps: EBProps = {
    stage,
    region,
    instanceType: "t3.small",
    solutionStackName,
    vpc,
    securityGroups,
    instanceProfileName,
    dockerPath: "docker-unified", // Unified docker configuration
    environment: {
      TZ: "America/Chicago",
      // EFS_ID: fileSystem.fileSystemId,
      DOMAIN: 'batch.' + config.domain,
      PRIVATE_ZONE_ID: "Z02458833BN9S7SLE8J71",
      PUBLIC_ZONE_ID: "Z01514342XRAVNZ06MTDD",
      NAME_MODE: "id", // id or ip
      TG_PORT: "80",
      HEALTH_CHECK_PATH: "/health",
      TTL: "60",
    },
    options: {
      TZ: "America/Chicago",
      // EFS_ID: fileSystem.fileSystemId,
    },
    publicIngress: [],
    // versionId: "xxx",
    // sourcePath: "",
  };

  let mainEb: any = null;
  const workers: { [key: string]: any } = {};
  const outputs: { [key: string]: string } = {};

  if (config.cronicleRole === "master") {
    // Master Cluster: Deploy only the master server
    console.log(`Deploying MASTER cluster for environment: ${config.name}`);

    // Main EB Environment (Master/Primary)
    mainEb = await ElasticBeanstalkDocker.make(
      stack,
      `${STACKNAME}-master`,
      {
        ...ebProps,
        dockerEnvironment: "master",
        subdomain: ["batch"],
        maxOnDemand: 1,
        minOnDemand: 1,
        rootVolumeSize: 20,
        environment: {
          ...ebProps.environment,
          ...getCronicleEnvironmentVars(accountId, "master"),
          CRONICLE_server_comm_use_hostnames: CRONICLE_COMM_USE_HOSTNAMES,
        }
      }
    );
    outputs.MainUrl = mainEb.url;

  } else if (config.cronicleRole === "worker") {
    // Worker Cluster: Deploy only worker nodes for this specific environment
    console.log(`Deploying WORKER cluster for environment: ${config.name}`);

    const worker = await ElasticBeanstalkDocker.make(
      stack,
      `${STACKNAME}-worker-${config.name}`,
      {
        ...ebProps,
        dockerEnvironment: config.name,
        subdomain: [`batch-worker-${config.name}`],
        maxOnDemand: 3,
        minOnDemand: 1,
        rootVolumeSize: 20,
        environment: {
          ...ebProps.environment,
          ...getCronicleEnvironmentVars(accountId, "worker"),
          CRONICLE_server_comm_use_hostnames: CRONICLE_COMM_USE_HOSTNAMES,
        }
      }
    );
    workers[config.name] = worker;
  } else {
    // No Cronicle deployment for this environment
    console.log(`Skipping Cronicle deployment for environment: ${config.name} (role: ${config.cronicleRole})`);
  }

  stack.addOutputs(outputs);

  return {
    mainEb,
    workers,
    vpc,
    ebInstanceRole,
    securityGroups,
    ebProps
  };
}
