interface EnvConfig {
  readonly env: {
    readonly account?: string;
    readonly region: string;
  };
  readonly name: string;
  readonly cidr: string;
  readonly domain: string;
  readonly zoneId?: string;
  readonly deployTag?: string;
  readonly buildCache: string;
  readonly sshKey?: string;
  readonly uploadBucket: string;
  // readonly stacks?: Stacks;
}

const CONFIGS: EnvConfig[] = [
  {
    name: "ops",
    env: {
      account: "337636387741",
      region: "us-east-2",
    },
    cidr: "10.3.0.0/16",
    domain: "paops.xyz",
    zoneId: "Z01514342XRAVNZ06MTDD",
    deployTag: "padev.xyz",
    sshKey: "paops2",
    buildCache: "",
    uploadBucket: "",
  },
  {
    name: "dev2",
    env: {
      account: "182399724557",
      region: "us-east-2",
    },
    cidr: "10.2.0.0/16",
    // domain: "dnwops.xyz",
    // zoneId: "Z09141762B8G9J18TM6ER",
    domain: "padev.xyz",
    // zoneId: "Z0739732391L1O5JM4HDX",
    buildCache: "",
    uploadBucket: "",
  },
  {
    name: "dev",
    env: {
      account: "309032041076",
      region: "us-east-1",
    },
    cidr: "10.2.0.0/16",
    domain: "padev.xyz",
    zoneId: "Z0739732391L1O5JM4HDX",
    buildCache: "",
    uploadBucket: "",
  },
  {
    name: "qa",
    env: {
      account: "829630018364",
      region: "us-east-2",
    },
    cidr: "10.1.0.0/16",
    domain: "paqa.xyz",
    zoneId: "Z00852331TWGCP4Z0531E",
    buildCache: "",
    uploadBucket: "",
  },
  {
    name: "live",
    env: {
      account: "331322215907",
      region: "us-east-2",
    },
    cidr: "10.0.0.0/16",
    domain: "privateauto.com",
    sshKey: "paprd",
    zoneId: "Z00110831G3QQ6YUW04Y7",
    buildCache: "",
    uploadBucket: "",
  },
];

const BUILDS_BUCKET = process.env.BUILDS_BUCKET || "pa-build-assets";

export function configure(accountId) {
  const configIndex = CONFIGS.findIndex((c) => c.env.account === accountId);
  if (configIndex == -1)
    throw new Error(`Configuration for account "${accountId}" not found!`);

  const config = CONFIGS[configIndex];

  return {
    ...CONFIGS[configIndex],
    buildCache: process.env.CACHE_BUCKET || `pa-build-cache-${config.name}`,
    uploadBucket: `pa-${config.name}-api-uploads`,
  };
}
