
export const CRONICLE_BASE_URL = "https://batch.paops.xyz"; // Master Cronicle server URL

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
  readonly cronicleRole: "master" | "worker" | "none";
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
    cronicleRole: "master",
  },
  {
    name: "dev",
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
    cronicleRole: "worker",
  },
  {
    name: "dev2",
    env: {
      account: "309032041076",
      region: "us-east-1",
    },
    cidr: "10.2.0.0/16",
    domain: "padev.xyz",
    zoneId: "Z0739732391L1O5JM4HDX",
    buildCache: "",
    uploadBucket: "",
    cronicleRole: "worker",
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
    cronicleRole: "none",
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
    cronicleRole: "worker",
  },
];

export function configure(accountId: string) {
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

export function getCronicleEnvironmentVars(
  accountId: string,
  deploymentType: "master" | "worker",
  workerName?: string
): Record<string, string> {
  const config = configure(accountId);

  // Derive environment name - for workers, use workerName or fall back to config.name
  const envName = workerName || config.name;

  // Simplified cluster role logic: master deployment on master environment = master, otherwise worker
  const clusterRole = deploymentType === "master" && config.cronicleRole === "master" ? "master" : "worker";

  // For master environments, use "master" for all identifiers; for workers, use the environment name
  const identifier = config.cronicleRole === "master" ? "master" : envName;

  return {
    CRONICLE_base_app_url: CRONICLE_BASE_URL,
    CRONICLE_SERVER_GROUP: identifier,
    CRONICLE_ENVIRONMENT: identifier,
    WORKER_ENVIRONMENT: identifier,
    CRONICLE_CLUSTER_ROLE: clusterRole,
    CRONICLE_web_direct_connect: clusterRole === "master" ? "1" : "0",
  };
}
