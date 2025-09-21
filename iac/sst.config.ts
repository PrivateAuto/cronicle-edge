import type { SSTConfig } from "sst";
import { cronicleMainEB } from "./stacks/cronicleMainEB";

export const VPC_NAME = "pa-net-vpc";
export const STACKNAME = "cronicle";

export default {
  config(input) {
    return {
      name: STACKNAME,
      region: process?.env?.AWS_REGION ?? "us-east-2",
    };
  },
  async stacks(app) {
    await app.stack(cronicleMainEB);
  },
} satisfies SSTConfig;
//
