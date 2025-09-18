import { RemovalPolicy } from "aws-cdk-lib";
import { Vpc, SubnetType, Peer, Port } from "aws-cdk-lib/aws-ec2";
import { FileSystem, LifecyclePolicy, PerformanceMode, ThroughputMode } from "aws-cdk-lib/aws-efs";
import { StackContext } from "sst/constructs";
import { VPC_NAME } from "../sst.config";

export function cronicleEFSStack(ctx: StackContext, vpcName: string = VPC_NAME) {
  const stack: any = ctx.stack;
  const vpc = Vpc.fromLookup(stack, "VPC", { vpcName });
  const fileSystem = new FileSystem(stack, "CronicleEfs", {
    vpc,
    removalPolicy: RemovalPolicy.RETAIN,
    lifecyclePolicy: LifecyclePolicy.AFTER_14_DAYS,
    performanceMode: PerformanceMode.GENERAL_PURPOSE,
    throughputMode: ThroughputMode.BURSTING,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
  });

  // Allow EFS from EB SGs
  const efsSg = fileSystem.connections.securityGroups[0];
  efsSg.addIngressRule(
    Peer.ipv4("10.0.0.0/8"),
    Port.tcp(2049),
    "Allow NFS from VPC"
  );

  stack.addOutputs({
    EFSId: fileSystem.fileSystemId,
  });

  return fileSystem;
}
