import { StackContext, use } from "sst/constructs";
import { ElasticBeanstalkDocker } from "./ElasticBeanstalkDocker";
import { VPC_NAME, STACKNAME } from "../sst.config";
import { cronicleShared } from "./cronicleShared";


export async function cronicleMainEB(ctx: StackContext, vpcName: string = VPC_NAME) {
  const stack: any = ctx.stack;
  const shared = use(cronicleShared);

  // Main EB Environment
  const mainEb = await ElasticBeanstalkDocker.make(
    stack,
    `${STACKNAME}-master`,
    {
      ...shared.ebProps,
      // sourcePath: "docker-main",
      subdomain: ["batch"],
      minOnDemand: 1
    }
  );

  stack.addOutputs({
    MainUrl: mainEb.url,
  });

  return { mainEb };
}
