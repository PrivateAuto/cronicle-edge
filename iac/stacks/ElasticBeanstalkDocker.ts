import { Construct } from "constructs";
import { IRole, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import * as eb from "aws-cdk-lib/aws-elasticbeanstalk";
import { execSync } from "child_process";
import * as path from "path";
import { IVpc, ISecurityGroup } from "aws-cdk-lib/aws-ec2";
import {
  getVPC,
  importALB,
  collapse,
  inPortsToSecurityGroups,
  makeIAMRole,
} from "./utils";
import { mapToCfnOptions, makeEBInstanceRole } from "./eb-utils";
import { IApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnInstanceProfile } from "aws-cdk-lib/aws-iam";

const STAGES: Record<string, Record<string, any>> = {
  paops: {
    name: "ops",
    env: {
      account: "337636387741",
      region: "us-east-2",
    },
    cidr: "10.3.0.0/16",
    domain: "paops.xyz",
    sshKey: "paops2",
    zoneId: "Z01514342XRAVNZ06MTDD",
    uploadBucket: "pa-build-cache-ops",
    loadBalancer: "pa-external-lb",
  },
  padev: {
    name: "dev",
    env: {
      account: "182399724557",
      region: "us-east-2",
    },
    cidr: "10.2.0.0/16",
    domain: "padev.xyz",
    zoneId: "Z0739732391L1O5JM4HDX",
    uploadBucket: "pa-build-cache-dev2",
    loadBalancer: "pa-external-lb",
  },
  pa: {
    name: "live",
    env: {
      account: "331322215907",
      region: "us-east-2",
    },
    cidr: "10.0.0.0/16",
    domain: "privateauto.com",
    sshKey: "paprd",
    zoneId: "Z00110831G3QQ6YUW04Y7",
    uploadBucket: "pa-build-cache-live-us-east-2",
    loadBalancer: "api-cluster-live-ext-lb",
  },
};

export interface EBProps {
  stage: string;
  subdomain?: string[];
  pathPatterns?: string[];
  networkName?: string;
  loadBalancer?: string | IApplicationLoadBalancer;
  port?: string;
  domain?: string;
  region: string;
  instanceType: string;
  vpc: string | IVpc;
  securityGroups: ISecurityGroup[];
  solutionStackName?: string;
  instanceRole?: IRole | Role;
  instanceProfileName?: string;
  serviceRoleName?: string;
  environment?: Record<string, string>;
  options?: Record<string, string>;
  dockerComposeFile?: string;
  dockerPath?: string;
  dockerEnvironment?: string;
  sshKeyName?: string;
  minOnDemand?: number;
  maxOnDemand?: number;
  spotBase?: number;
  spotAbovePct?: number;
  publicIngress?: number[];
  instancePolicies?: string[];
  instanceAWSPolicies?: string[];
  instanceInlinePolicies?: PolicyStatement[];
  publicInstances?: boolean;
  rootVolumeSize?: number;
}

const DEFAULTS: Partial<EBProps> = {
  dockerComposeFile: "docker-compose.yml",
  dockerPath: "docker-unified", // Contains platform hooks that handle DNS/ALB failures gracefully
  //subdomain: ["workflow"],
  pathPatterns: ["*"],
  networkName: "pa-net-vpc",
  serviceRoleName: "",
  instanceProfileName: "aws-elasticbeanstalk-ec2-role",
  port: "80",
};

export class ElasticBeanstalkDocker extends Construct {
  public url?: string;
  public asset?: string;
  public app?: eb.CfnApplication;
  public env?: eb.CfnEnvironment;
  public ver?: eb.CfnApplicationVersion;

  private constructor(scope: Construct, appName: string, props: EBProps) {
    super(scope, appName);
  }

  static async make(
    scope: Construct,
    appName: string,
    propsIn: EBProps
  ): Promise<ElasticBeanstalkDocker> {
    const stageValues: any = STAGES[propsIn.stage];
    // console.log(`stage: ${propsIn.stage}`);
    // console.log(`stageValues: ${JSON.stringify(stageValues)}`);
    const props: EBProps = {
      ...DEFAULTS,
      domain: stageValues.domain,
      loadBalancer: stageValues.loadBalancer,
      ...propsIn,
    };
    const { region = "us-east-2" } = props;
    const publicInstances = props.publicInstances ?? false;

    const ebApp = new ElasticBeanstalkDocker(scope, `${appName}-eb`, props);

    const vpc =
      typeof props.vpc === "string"
        ? getVPC(scope, props.vpc, region)
        : props.vpc;
    console.log(`******* VPC Found: `, vpc?.vpcId);

    const lb =
      typeof props.loadBalancer === "string"
        ? importALB(scope, props.loadBalancer, appName)
        : props.loadBalancer;
    console.log(
      `loadBalancer: ${lb?.loadBalancerDnsName} on ${lb?.vpc?.vpcId}`
    );

    // in ports to security groups
    let securityGroupIds: string[] = inPortsToSecurityGroups(
      props.publicIngress ?? [],
      scope,
      vpc,
      appName
    );

    const app = new eb.CfnApplication(scope, `${appName}-app`, {
      applicationName: `${appName}-app`,
    });

    console.log(`applicationName: ${app.applicationName}`);

    const policies = [
      "pa-apiBasicAccess-policy",
      "pa-s3ReadOnlyAccess-policy",
      "pa-s3FullAccess-policy",
      "pa-ssmAccess-policy",
    ];

    // props.domain ?? stageValues.domain;
    // props.sshKeyName ?? stageValues.sshKey;
    //   serviceRoleName: `${id}-service-role`,

    // instance role
    const instanceRole =
      props.instanceRole ??
      makeEBInstanceRole(
        scope,
        `${appName}`, // instanceRoleName,
        [...(props.instanceAWSPolicies ?? []), "AWSIoTFullAccess"],
        [], // [...(props.instancePolicies ?? []), ...policies],
        [] // props.instanceInlinePolicies ?? []
      );

    // instance profile
    const instanceProfileName = `${appName}-instance-profile`;
    const instanceProfile = new CfnInstanceProfile(
      scope,
      `${appName}-instance-profile`,
      {
        instanceProfileName,
        roles: [instanceRole.roleName],
      }
    );

    console.log(`instanceRole.roleName: ${instanceRole.roleName}`);
    console.log(`instanceProfileName: ${instanceProfileName}`);

    // service role
    const serviceRole = makeIAMRole(
      scope,
      `${appName}-service-role`,
      "elasticbeanstalk.amazonaws.com",
      [
        "AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy",
        "AWSElasticBeanstalkWebTier",
        "AWSIoTFullAccess",
        "AmazonSSMManagedInstanceCore",
        "AmazonEC2ContainerRegistryFullAccess",
        // "service-role/AWSElasticBeanstalkRoleCore",
        // "aws-service-role/AWSElasticBeanstalkServiceRolePolicy",
      ],
      [...(props.instancePolicies ?? []), ...policies],
      props.instanceInlinePolicies ?? []
    );

    const publicSubnets = vpc?.publicSubnets
      ?.map((s:any) => s.subnetId)
      ?.join(", ");
    const privateSubnets = vpc?.privateSubnets
      ?.map((s:any) => s.subnetId)
      ?.join(", ");

    const options = {
      aws: {
        autoscaling: {
          launchconfiguration: {
            InstanceType: props.instanceType ?? "t3.small",
            IamInstanceProfile:
              props.instanceProfileName ??
              instanceProfileName ??
              "aws-elasticbeanstalk-ec2-role",
            EC2KeyName: props.sshKeyName ?? stageValues.sshKey,
            SecurityGroups: props.securityGroups
              .map((sg) => sg.securityGroupId)
              .join(","),
            ...(props.rootVolumeSize && {
              RootVolumeSize: String(props.rootVolumeSize),
              RootVolumeType: "gp3",
            }),
          },
          asg: {
            MinSize: String(props.minOnDemand ?? 1),
            MaxSize: String(props.maxOnDemand ?? 4),
          },
        },
        ec2: {
          instances: {
            SpotFleetOnDemandBase: String(props.spotBase ?? 0),
            SpotFleetOnDemandAboveBasePercentage: String(
              props.spotAbovePct ?? 0
            ),
          },
          vpc: {
            VPCId: vpc?.vpcId,
            Subnets: publicInstances ? publicSubnets : privateSubnets,
            ELBSubnets: publicSubnets,
            associatePublicIpAddress: publicInstances,
          },
        },

        elasticbeanstalk: {
          application: {
            environment: {
              AWS_REGION: props.region,
              BASE_HOST: props.domain,
              ...(props.environment ?? []),
            },
          },
          environment: {
            LoadBalancerType: "application",
            LoadBalancerIsShared: "true",
            ServiceRole: props.serviceRoleName,
            process: {
              default: {
                HealthCheckPath: "/",
                MatcherHTTPCode: "200,301,302,400,401,403,404",
                Port: props.port,
              },
            },
          },
          cloudwatch: { logs: { StreamLogs: "true" } },
          monitoring: {
            "Automatically Terminate Unhealthy Instances": "true",
          },
        },
        elbv2: {
          ...(lb
            ? {
                loadbalancer: {
                  SharedLoadBalancer: lb.loadBalancerArn,
                },
              }
            : {}),
          listenerrule: {
            ebRule: {
              HostHeaders: props?.subdomain
                ?.map((sub) =>
                  [sub, props.domain]
                    .filter((v) => v != undefined && v != null && v != "")
                    .join(".")
                )
                .join(","),
              PathPatterns:
                props.pathPatterns && props.pathPatterns.length > 0
                  ? props.pathPatterns.join(",")
                  : "/*",
            },
          },
          listener: {
            "443": { Rules: "ebRule" },
          },
        },
      },
    };

    // console.log(`options: `, mapToCfnOptions(collapse(props.options ?? {})));
    // console.log(`options: `, mapToCfnOptions(collapse(options)));

    const elbEnv = new eb.CfnEnvironment(scope, `${appName}-env`, {
      // environmentName: `${appName}-${(props.versionId ?? "").split("-").pop()}`,
      environmentName: `${appName}-env`,
      applicationName: app.applicationName ?? appName,
      solutionStackName: props.solutionStackName,
      optionSettings: mapToCfnOptions(collapse(options)),
      // versionLabel: appVersion.ref,
    });

    //appVersion.addDependency(app);
    //elbEnv.addDependency(appVersion);
    elbEnv.addDependency(app);

    ebApp.url = elbEnv.attrEndpointUrl;
    // ebApp.asset = zip;
    ebApp.app = app;
    ebApp.env = elbEnv;
    // ebApp.ver = appVersion;

    return ebApp;
  }
}

function makeZipFile(
  zipName: string,
  sourcePath: string,
  destDir: string = process.cwd()
) {
  // console.log(`zipName: ${zipName}  sourcePath: ${sourcePath}`);
  const zipFilePath = path.join(destDir, `${path.basename(zipName)}.zip`);
  // console.log(`zipFilePath: ${zipFilePath}`);

  // -r = recursion, -q = quiet, -y = include symlinks, -9 = best compression
  // The dot after the source path ensures hidden files are included
  execSync(`zip -r9q "${zipFilePath}" .`, {
    cwd: sourcePath,
    stdio: "inherit",
  });
  return zipFilePath;
}
