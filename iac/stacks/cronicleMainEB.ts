import { StackContext, use } from "sst/constructs";
import { ElasticBeanstalkDocker } from "./ElasticBeanstalkDocker";
import { STACKNAME } from "../sst.config";
import { cronicleShared } from "./cronicleShared";

export async function cronicleMainEB(ctx: StackContext) {
  const stack: any = ctx.stack;
  const shared = use(cronicleShared);

  // Main EB Environment
  const mainEb = await ElasticBeanstalkDocker.make(
    stack,
    `${STACKNAME}`,
    {
      ...shared.ebProps,
      subdomain: ["batch"],
      minOnDemand: 1,
      rootVolumeSize: 30
    }
  );

  stack.addOutputs({
    MainUrl: mainEb.url,
  });

  return { mainEb };
}
