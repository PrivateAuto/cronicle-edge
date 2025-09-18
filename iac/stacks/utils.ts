import { Construct } from "constructs";
import { Stack, Duration, CfnOutput } from "aws-cdk-lib";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { EventBus, Rule, EventPattern } from "aws-cdk-lib/aws-events";
import { HttpMethod, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import {
  RestApi,
  RestApiProps,
  LambdaIntegration,
} from "aws-cdk-lib/aws-apigateway";
import {
  HttpMethod as GWHttpMethod,
  HttpApi,
  AddRoutesOptions,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  IPrincipal,
  ManagedPolicy,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
  CompositePrincipal,
} from "aws-cdk-lib/aws-iam";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { configure } from "./env-configs";
import { Environment, TagManager, TagType, Fn } from "aws-cdk-lib";
import {
  Function,
  Runtime,
  Code,
  FunctionUrlProps,
} from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { IVpc, Vpc, SecurityGroup, Port, Peer } from "aws-cdk-lib/aws-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { QueueEncryption } from "aws-cdk-lib/aws-sqs";
import {
  IApplicationLoadBalancer,
  ApplicationLoadBalancer,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";

const DEFAULT_CODE =
  'exports.handler = function(event, ctx, cb) { return cb(null, "hi"); }';

export function logsPolicy(parent: Construct, group: string) {
  return [
    new PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:CreateLogGroup"],
      resources: [`arn:aws:logs:::log-group:/pa/pa-${group}*:*`],
    }),
    new PolicyStatement({
      actions: ["logs:PutLogEvents"],
      resources: [`arn:aws:logs:::log-group:/pa/pa-${group}*:*`],
    }),
  ];
}

export function ssmPolicy(parent: Construct, env: Environment, id: string) {
  return [
    new PolicyStatement({
      actions: ["ssm:GetParam*"],
      resources: [`arn:aws:ssm:${env.region}:${env.account}:parameter/*`],
    }),
  ];
}

export function queuePolicy(parent: Construct, queueName: string) {
  return [
    new PolicyStatement({
      actions: [
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
      ],
      resources: [`arn:aws:sqs:::${queueName}`],
    }),
  ];
}

export async function findS3Asset(
  appName: string,
  Bucket: string,
  tag?: string
): Promise<string | undefined> {
  /*
  const objs = await s3
    .listObjects({ Bucket: BUILDS_BUCKET, Prefix: appName })
    .promise();

  if (objs.Contents && objs.Contents.length > 0) {
    const build = objs.Contents.reduce((acc, cur) =>
      cur.LastModified &&
      (!acc || !acc.LastModified || cur.LastModified > acc.LastModified)
        ? cur
        : acc
    );
    if (build && build.Key) {
      await s3
        .copyObject({
          Bucket,
          CopySource: `${BUILDS_BUCKET}/${build.Key}`,
          Key: build.Key,
        })
        .promise();

      // console.log(`Using cached build ${build.Key}`);

      return build.Key;
    }
  }
  */

  return undefined;
}

export async function findS3Build(
  parent: Construct,
  appName: string,
  bucket: string,
  tag?: string
): Promise<Code> {
  return findS3Asset(appName, bucket, tag).then((key) =>
    makeS3Build(parent, bucket, key)
  );
}

export async function makeS3Build(
  parent: Construct,
  bucketName: string,
  key: string | undefined
): Promise<Code> {
  if (key) {
    const bucket = Bucket.fromBucketName(parent, "imported-bucket", bucketName);
    // console.log(`Using cached build ${key}`);
    return Code.fromBucket(bucket, key);
  }
  return Code.fromInline(DEFAULT_CODE);
}

export function getVPC(
  parent: Construct,
  networkName: string,
  region: string
): IVpc {
  // console.log(`getVPC(${networkName}, ${region})`);
  const searchTags = new TagManager(TagType.KEY_VALUE, "AWS::EC2::VPC", {
    "pa-use": networkName,
  });
  const vpc = Vpc.fromLookup(parent, "imported-vpc", {
    vpcName: "pa-net-vpc",
    region: region,
    tags: searchTags.tagValues(),
  });
  //console.log(`VPC: ${vpc ? vpc.vpcId + "/" + JSON.stringify(vpc.env) : "not found"}`);
  return vpc;
}

export function importSecurityGroup(parent: Construct, id: string) {
  console.log(`start: importSecurityGroup`);
  const sg = SecurityGroup.fromSecurityGroupId(parent, `${id}-sg`, id, {});
  console.log(`exit: importSecurityGroup`);
  return sg;
}

export function importPolicy(parent: Construct, id: string) {
  return Policy.fromPolicyName(parent, `${id}-policy`, id);
}

export function importManagedPolicy(parent: Construct, id: string) {
  return ManagedPolicy.fromManagedPolicyName(parent, `${id}-policy`, id);
}

export function importLambda(parent: Construct, functionID: string) {
  const importName = Fn.importValue(`lambda-${functionID}-name`);
  console.log(`Lambda Name: ${importName}  -- ${functionID}`);
  return Function.fromFunctionName(
    parent,
    `imported-${functionID}`,
    importName
  );
}

export function importExtLambda(parent: Construct, functionName: string) {
  console.log(`Lambda External Name: ${functionName}`);
  return Function.fromFunctionName(
    parent,
    `imported-${functionName}`,
    functionName
  );
}

export function addAwsPolicy(r: Role, n: string) {
  r.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName(n));
}

export function addManagedPolicy(
  parent: Construct,
  r: Role,
  p: string | ManagedPolicy
) {
  const mp = typeof p === "string"
  ? ManagedPolicy.fromManagedPolicyName(parent, `import-policy-${p}`, p)
  : p
  console.log(`addManagedPolicy(${r.roleName}, ${p}) => `, mp.managedPolicyArn);
  r.addManagedPolicy(mp);
}

export function addPolicy(parent: Construct, r: Role, p: Policy) {
  r.attachInlinePolicy(p);
}

export function makeIAMRole(
  parent: Construct,
  id: string,
  principal: IPrincipal | string | string[] = [],
  awsPolicies: string[] = [],
  policies: (string | ManagedPolicy)[] = [],
  inline: PolicyStatement[] = []
) {
  const params: any = { roleName: id };
  if (principal)
    params.assumedBy = Array.isArray(principal)
      ? new CompositePrincipal(...principal.map((p) => new ServicePrincipal(p)))
      : typeof principal === "string"
      ? new ServicePrincipal(principal)
      : principal;

  const role = new Role(parent, `${id}-role`, params);
  // awsPolicies.forEach((ap) => addAwsPolicy(role, `${id}-${ap}`));
  awsPolicies.forEach((ap) => addAwsPolicy(role, ap));
  //console.log(`id:`, id);
  //console.log(`makeIAMRole policies:`, policies);
  // policies.forEach((up) => addManagedPolicy(parent, role, `${id}-${up}`));
  policies.forEach((up) => addManagedPolicy(parent, role, up));
  // const pols = inline.filter((p) => p instanceof Policy);
  // const pols =  <IPolicy[]> inline.filter((p) => !(p instanceof PolicyStatement));
  // const stmts = <PolicyStatement[]> inline.filter((p) => p instanceof PolicyStatement);
  //if (stmts.length > 0) {
  //  pols.push(new Policy(parent, `pa-inline-policy`, { statements: stmts }));
  //}

  if (inline?.length > 0) {
    role.attachInlinePolicy(
      new Policy(parent, `${id}-inline-policy`, {
        statements: [...inline],
      })
    );
  }

  return role;
}

export function makeLambdaRole(
  parent: Construct,
  id: string,
  awsPolicies: string[] = [],
  policies: (string | ManagedPolicy)[] = [],
  inline: PolicyStatement[] = []
) {
  return makeIAMRole(
    parent,
    id,
    "lambda.amazonaws.com",
    [
      "service-role/AWSLambdaBasicExecutionRole",
      "service-role/AWSLambdaVPCAccessExecutionRole",
      ...awsPolicies,
    ],
    policies,
    [...logsPolicy(parent, id), ...inline]
  );
}

export async function getAccountId(): Promise<string> {
  const client = new STSClient({});
  const command = new GetCallerIdentityCommand({});
  const accountId = await client.send(command).then((r) => r.Account);
  if (!accountId) throw new Error("Could not get account id");
  return accountId;
}

export interface APIRoutes {
  [key: string]: Partial<AddRoutesOptions>;
}

export interface PALambdaParams {
  awsPolicies: string[];
  policies: (string | ManagedPolicy)[];
  inline: PolicyStatement[];
  principals: string[];
  timeout: any; // Duration;
  memorySize: number;
  isAsync: boolean;
  useDlq: boolean;
  networkName: string;
  runtime: Runtime;
  reservedConcurrentExecutions: number;
  handler: string;
  environment: { [key: string]: string };
  code: Code;
  eventBusName: string;
  eventRules: { [key: string]: EventPattern };
  hasUrl: boolean;
  urlProps: Partial<FunctionUrlProps>;
  urlExportName?: string;
  hasApi: boolean;
  apiProps: APIRoutes;
  restApiProps: RestApiProps;
}

const DEFAULTS: PALambdaParams = {
  awsPolicies: [],
  policies: [],
  inline: [],
  principals: [],
  timeout: Duration.minutes(5),
  memorySize: 0,
  isAsync: false,
  useDlq: false,
  networkName: "pa-network",
  runtime: Runtime.NODEJS_20_X,
  reservedConcurrentExecutions: 0,
  handler: "index.handler",
  environment: {},
  code: Code.fromInline(DEFAULT_CODE),
  eventBusName: "",
  eventRules: {},
  hasUrl: false,
  urlProps: {
    authType: FunctionUrlAuthType.NONE,
    cors: {
      allowedOrigins: ["*"],
      allowedMethods: [HttpMethod.GET, HttpMethod.POST],
    },
  },
  hasApi: false,
  apiProps: {},
  restApiProps: {},
};

export async function makeLambda(
  parent: Construct,
  lambdaName: string,
  fParams: Partial<PALambdaParams>
) {
  const params: PALambdaParams = { ...DEFAULTS, ...fParams };

  const accountId: string = await getAccountId();
  const config = configure(accountId);

  const env = config.env;
  console.log(`Using acount id: ${accountId} in region: ${env.region}`);

  const id = lambdaName;

  const stack = new Stack(parent, `lambda-${lambdaName}-stack`, {
    stackName: `lambda-${lambdaName}`,
    env,
  });

  const queueName = `${lambdaName}-q`;
  const dlqName = `${lambdaName}-dlq`;

  const {
    awsPolicies,
    policies,
    inline,
    principals,
    isAsync,
    useDlq,
    networkName,
  } = params;

  const vpc = getVPC(stack, networkName, env.region || "");

  awsPolicies.push(
    "service-role/AWSLambdaBasicExecutionRole",
    "service-role/AWSLambdaVPCAccessExecutionRole"
  );

  inline.push(...ssmPolicy(stack, env, id), ...logsPolicy(stack, id));
  if (isAsync) inline.push(...queuePolicy(stack, queueName));

  const role = makeIAMRole(
    stack,
    id,
    "lambda.amazonaws.com",
    awsPolicies,
    policies,
    inline
  );

  const props: any = {
    functionName: id,
    role,
    vpc,
    runtime: params.runtime,
    handler: params.handler,
    code: params.code,
    timeout: params.timeout,
    environment: params.environment,
  };
  if (params.memorySize > 0) props.memorySize = params.memorySize;
  if (params.reservedConcurrentExecutions > 0) {
    // props.reservedConcurrentExecutions = params.reservedConcurrentExecutions;
  }

  if (useDlq) {
    props.deadLetterQueueEnabled = true;
    props.deadLetterQueue = new Queue(stack, dlqName, {
      encryption: QueueEncryption.KMS_MANAGED,
    });
  }

  const func = new Function(stack, `${id}`, props);

  principals.forEach((p) => func.grantInvoke(new ServicePrincipal(p)));

  if (isAsync) {
    func.addEventSource(
      new SqsEventSource(
        new Queue(stack, queueName, {
          queueName: queueName,
          visibilityTimeout: params.timeout,
          encryption: QueueEncryption.KMS_MANAGED,
        })
      )
    );
  }

  if (params.eventBusName.trim().length > 0) {
    const bus = EventBus.fromEventBusName(
      stack,
      `${id}-bus`,
      params.eventBusName
    );

    func.addPermission(`${id}-event-permission`, {
      principal: new ServicePrincipal("events.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:events:${config.env.region}:${config.env.account}:rule/*/*`,
    });

    Object.entries(params.eventRules).forEach(([id, eventPattern]) => {
      new Rule(stack, id, {
        eventBus: bus,
        eventPattern,
        targets: [new LambdaFunction(func, {})],
      });
    });
  }

  // function URL support
  if (params.hasUrl) {
    const fnUrl = func.addFunctionUrl(params.urlProps);
    if (params.urlExportName)
      new CfnOutput(stack, `${params.urlExportName}`, {
        value: fnUrl.url,
        exportName: `${params.urlExportName}`,
      });

    new CfnOutput(stack, `lambda-${id}-url`, {
      value: fnUrl.url,
      exportName: `lambda-${id}-url`,
    });
    new CfnOutput(stack, `lambda-${id}-stack-url`, {
      value: fnUrl.url,
      exportName: `lambda-${id}-stack-url`,
    });

    // create an Output for the API URL
    new CfnOutput(stack, `api-${id}-url-endpoint`, {
      value: `${fnUrl.url}`,
      exportName: `api-${id}-url-endpoint`,
    });
    new CfnOutput(stack, `api-${id}-stack-url-endpoint`, {
      value: `${fnUrl.url}`,
      exportName: `api-${id}-stack-url-endpoint`,
    });
  }

  // API Gateway support
  if (params.hasApi) {
    if (Object.keys(params.apiProps).length > 0) {
      const httpApi = new HttpApi(stack, `${id}-gateway`, {
        createDefaultStage: false,
      });
      Object.entries(params.apiProps).forEach(([path, props]) => {
        const rt = httpApi.addRoutes({
          path,
          methods: [GWHttpMethod.GET],
          integration: new HttpLambdaIntegration(
            `API integration for ${id}`,
            func
          ),
          ...props,
        });
        func.addPermission(`${id}-gateway-${path.replace(/\//g, "-")}`, {
          principal: new ServicePrincipal("apigateway.amazonaws.com"),
          action: "lambda:InvokeFunction",
          sourceArn: `arn:aws:execute-api:${config.env.region}:${config.env.account}:${rt[0].routeId}/*/*/getUploadedFileType`,
        });
      });
      httpApi.addStage("api", { stageName: "api", autoDeploy: true });

      // create an Output for the API URL
      new CfnOutput(stack, `api-${id}-endpoint`, {
        value: `${httpApi.apiEndpoint}/api`,
        exportName: `api-${id}-endpoint`,
      });
      new CfnOutput(stack, `api-${id}-stack-endpoint`, {
        value: `${httpApi.apiEndpoint}/api`,
        exportName: `api-${id}-stack-endpoint`,
      });
    }
  }

  // REST API support
  if (params.restApiProps && Object.keys(params.restApiProps).length > 0) {
    func.addPermission(`${id}-rest-api-permission`, {
      principal: new ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${config.env.region}:${config.env.account}:*/*/*/*`,
    });

    const restApi = new RestApi(stack, `${id}-rest-api`, {
      restApiName: `${id}-rest-api`,
      ...params.restApiProps,
    });

    restApi.root.addProxy({
      anyMethod: true,
      defaultIntegration: new LambdaIntegration(func, {
        proxy: true,
      }),
    });

    new CfnOutput(stack, `api-${id}-endpoint`, {
      value: restApi.url,
      exportName: `api-${id}-endpoint`,
    });
  }

  new CfnOutput(stack, `lambda-${id}-arn`, {
    value: func.functionArn,
    exportName: `lambda-${id}-arn`,
  });
  new CfnOutput(stack, `lambda-${id}-name`, {
    value: func.functionName,
    exportName: `lambda-${id}-name`,
  });
}

export function keySplit(key: string): string[] {
  const idx = key.lastIndexOf(":");
  return [key.substring(0, idx), key.substring(idx + 1)];
}

export function importALB(
  scope: Construct,
  paUse: string,
  discriminator: string = ""
) {
  return ApplicationLoadBalancer.fromLookup(
    scope,
    ["imported", discriminator, paUse].filter((p) => p.length > 0).join("-"),
    {
      loadBalancerTags: makeTags(paUse),
    }
  );
}

export function makeTags(
  value: string,
  keyName: string = "pa-use",
  resourceType: string = "AWS::ElasticLoadBalancingV2"
) {
  if (value) {
    return new TagManager(TagType.KEY_VALUE, resourceType, {
      [keyName]: value,
    }).tagValues();
  }
}

export function collapse(
  obj: Object,
  seperator: string = ":",
  paths: string[] = []
) {
  let res = {};
  Object.keys(obj).forEach((k) => {
    if (typeof obj[k] === "object") {
      res = { ...res, ...collapse(obj[k], seperator, [...paths, k]) };
    } else {
      res[[...paths, k].join(seperator)] = obj[k];
    }
  });
  return res;
}

export async function getSSMParam(Name: string, region: string = "us-east-2") {
  const ssm = new SSMClient(region ? { region } : {});
  try {
    const param = await ssm.send(
      new GetParameterCommand({ Name, WithDecryption: true })
    );
    return param?.Parameter?.Value;
  } catch (e) {
    console.log(`SSM PArameter Fail [${Name}]`, e);
    throw e;
  }
}

export function inPortsToSecurityGroups(
  publicIngress: number[],
  parent: Construct,
  vpc: IVpc,
  id: string
) {
  let securityGroupIds: string[] = [];
  const securityGroups = ["allAllowOut", "allAllowV4From10"];
  if (Array.isArray(publicIngress) && publicIngress.length > 0) {
    let inPorts = publicIngress;
    if (inPorts.includes(80)) securityGroups.push("httpAllowV4FromAll");
    if (inPorts.includes(443)) securityGroups.push("httpsAllowV4FromAll");
    inPorts = inPorts.filter((p) => p !== 80 && p !== 443);
    securityGroupIds = securityGroups.map((sg) => {
      const sg2 = SecurityGroup.fromLookupByName(
        parent,
        `sg-import-${sg}`,
        sg,
        vpc
      );
      console.log(`Mapped ${sg} to ${sg2.securityGroupId}`);
      return sg2.securityGroupId;
    });

    if (inPorts.length > 0) {
      const sg = new SecurityGroup(parent, `${id}-extra-ports-sg`, {
        vpc,
        securityGroupName: `${id}-extra-ports-sg`,
      });
      inPorts.forEach((p) => {
        sg.addIngressRule(
          Peer.anyIpv4(),
          Port.tcp(p),
          `allow ${p} access from anywhere`
        );
      });
      securityGroupIds.push(sg.securityGroupId);
    }
  }
  return securityGroupIds;
}
