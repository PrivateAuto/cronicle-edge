import { Construct } from "constructs";
import { ElasticBeanstalk } from "@aws-sdk/client-elastic-beanstalk";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as path from "path";

import { CfnEnvironment } from "aws-cdk-lib/aws-elasticbeanstalk";
import { keySplit, makeIAMRole } from "./utils";
import { ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";

export async function uploadFileToS3(
  filePath: string,
  key?: string,
  bucket: string = getDefaultS3Bucket(),
  region: string = "us-east-2"
): Promise<{ bucket: string; key: string; url: string }> {
  const s3Key = key || path.basename(filePath);
  const s3 = new S3Client({ region });
  const fileStream = fs.createReadStream(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: fileStream,
      ContentType: "application/zip",
    })
  );
  const s3Url = `s3://${bucket}/${s3Key}`;
  // console.log(`Uploaded ${filePath} to ${s3Url}`);
  return { bucket, key: s3Key, url: s3Url };
}

export function getDefaultS3Bucket(): string {
  return "pa-build-assets";
}

export async function getStacks(region: string = "us-east-2") {
  const stacks = { node: {}, docker: "" };
  try {
    const ebApi = new ElasticBeanstalk({ region });
    const resp = await ebApi.listAvailableSolutionStacks();
    if (Array.isArray(resp.SolutionStacks)) {
      resp.SolutionStacks.sort().forEach((s: any) => {
        const ver = s.match("Linux.*Node.*([0-9]{2})");
        if (ver) stacks.node[ver[1]] = s;
        if (s.match("Linux.*Docker")) stacks.docker = s;
      });
    }
  } catch (error) {
    console.log("Error:");
    console.log(error);
    // const { requestId, cfId, extendedRequestId } = error?.$metadata || {};
    // console.log({ requestId, cfId, extendedRequestId });
  }
  return stacks;
}

export async function getLastestDockerStack(region: string = "us-east-2") {
  const stacks = await getStacks(region);
  if (stacks === undefined || stacks.docker === undefined)
    throw new Error("No Docker stack found.");
  return stacks.docker;
}

export function interpolate(template: string, values: Record<string, any>) {
  return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return values[key] || match;
  });
}

export function mapToCfnOptions(
  options: Record<string, any>,
  context: Record<string, any> = {}
): CfnEnvironment.OptionSettingProperty[] {
  return Object.entries(options)
    .filter((opt) => opt[0] && opt[0].trim().length > 0 && opt[1])
    .map((opt): CfnEnvironment.OptionSettingProperty => {
      const [key, v] = opt;
      const value: string = interpolate(
        typeof v === "string" ? v : v.toString(),
        context
      );
      const [namespace, optionName] = keySplit(key);
      // console.log({ namespace, optionName, value });
      //if (namespace && namespace.trim().length > 0)
      return { namespace, optionName, value };
      // return { optionName, value };
    });
}

export function makeEBInstanceRole(
  parent: Construct,
  id: string,
  awsPolicies: string[] = [],
  policies: (string | ManagedPolicy)[] = [],
  inline: PolicyStatement[] = []
) {
  return makeIAMRole(
    parent,
    `${id}-instance-role`,
    "ec2.amazonaws.com",
    [
      ...awsPolicies,
      "AWSElasticBeanstalkWebTier",
      "service-role/AWSElasticBeanstalkRoleCore",
    ],
    policies,
    inline
  );
}
export function makeServiceRole(
  parent: Construct,
  id: string,
  awsPolicies: string[] = [],
  policies: (string | ManagedPolicy)[] = [],
  inline: PolicyStatement[] = []
) {
  return makeIAMRole(
    parent,
    `${id}-service-role`,
    "elasticbeanstalk.amazonaws.com",
    [
      ...awsPolicies,
      "AWSElasticBeanstalkWebTier",
      "service-role/AWSElasticBeanstalkRoleCore",
      "AmazonSSMManagedInstanceCore",
    ],
    policies,
    inline
  );
}

/*
  // serviceRoleName, instanceProfileName

  const vars = Object.keys(props.vars || [])
    .filter((k) => props.vars[k] && props.vars[k] != "")
    .reduce(
      (a, k) => ({
        ...a,
        [`aws:elasticbeanstalk:application:environment:${k}`]:
          typeof props.vars[k] === "string"
            ? props.vars[k]
                .replace(/${instanceProfile}/g, instanceProfileName ?? "")
                .replace(/${serviceRole}/g, serviceRoleName ?? "")
            : props.vars[k],
      }),
      {}
    );
*/
