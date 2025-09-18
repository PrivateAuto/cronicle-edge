import type { SSTConfig } from "sst";
import { cronicleEFSStack } from "./stacks/cronicleEFSStack";
import { cronicleMainEB } from "./stacks/cronicleMainEB";
import { cronicleShared } from "./stacks/cronicleShared";

export const VPC_NAME = "pa-net-vpc";
export const STACKNAME = "cronicle";

// export const pkgJson = getPackageJson(import.meta.url);

export default {
  config(input) {
    return {
      name: STACKNAME,
      region: process?.env?.AWS_REGION ?? "us-east-2",
    };
  },
  async stacks(app) {
    // EFS File System
    // .
    // await app.stack(cronicleEFSStack);

    // shared values and structures
    await app.stack(cronicleShared);
    await app.stack(cronicleMainEB);
  },
} satisfies SSTConfig;
//
