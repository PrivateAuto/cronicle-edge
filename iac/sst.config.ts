import type { SSTConfig, Stack } from "sst";
import { makePackageFromFolders, getPackageJson } from "@privateauto/pa-sst2";
import { cronicleEFSStack } from "./stacks/cronicleEFSStack";
import { cronicleMainEB } from "./stacks/cronicleMainEB";
import { cronicleShared } from "./stacks/cronicleShared";
import { StackContext } from "sst/constructs";

export const VPC_NAME = "pa-net-vpc";
export const STACKNAME = "cronicle";

export const pkgJson = getPackageJson(import.meta.url);

async function cronicleStack(ctx: StackContext) {
  // EFS File System
  console.log("====================== EFS Stack ======================");
  await ctx.app.stack(cronicleEFSStack);

  // shared values and structures
  console.log("====================== Shared ======================");
  await ctx.app.stack(cronicleShared);

  console.log("====================== Main ======================");
  await ctx.app.stack(cronicleMainEB);
}

export default {
  config(input) {
    return {
      name: makePackageFromFolders(import.meta.url.replace(".iac", "")),
      region: process?.env?.AWS_REGION ?? "us-east-2",
    };
  },
  async stacks(app) {
    console.log("======== SST Cronicle Deployment ========");
    await app.stack(cronicleStack);
  },
} satisfies SSTConfig;
//
