# Cronicle Environment-Specific Worker Deployment

This IaC configuration supports deploying Cronicle with environment-specific workers, with conditional deployment based on the environment type defined in `env-configs.ts`.

## Architecture

The deployment behavior is now determined by the `cronicleClusterType` attribute in `env-configs.ts`:

### Main Cluster (paops only)
When deployed to the `paops` environment (marked as "main"):
1. **Master Server** (`cronicle-master`) - Main Cronicle server for management
2. **PrivateAuto Worker** (`cronicle-worker-privateauto`) - Workers for privateauto environment
3. **PADev Worker** (`cronicle-worker-padev`) - Workers for padev environment

### Worker Clusters (all other environments)
When deployed to worker environments (`dev2`, `dev`, `qa`, `live`):
- Only deploys a single worker cluster specific to that environment
- Worker connects to the main cluster for coordination
- Environment-isolated job execution

**Note**: The shared infrastructure configuration has been merged into the main stack for simplified management.

## Environment Configuration

### Cluster Type Configuration (env-configs.ts)

- **ops** (paops): `"main"` - Deploys full cluster including master and all workers
- **dev2**: `"worker"` - Deploys only dev2-specific workers
- **dev**: `"worker"` - Deploys only dev-specific workers
- **qa**: `"worker"` - Deploys only qa-specific workers
- **live**: `"worker"` - Deploys only live-specific workers

### Worker Environment Configuration

Each worker deployment has environment-specific configuration based on the deployment target:

#### Main Cluster Workers (when deployed to paops)
- **PrivateAuto Worker**: Server Group `privateauto`, subdomain `batch-worker-privateauto.paops.xyz`
- **PADev Worker**: Server Group `padev`, subdomain `batch-worker-padev.paops.xyz`

#### Individual Worker Clusters (when deployed to other environments)
- **Dev2 Worker**: Server Group `dev2`, subdomain `batch-worker-dev2.padev.xyz`
- **Dev Worker**: Server Group `dev`, subdomain `batch-worker-dev.padev.xyz`
- **QA Worker**: Server Group `qa`, subdomain `batch-worker-qa.paqa.xyz`
- **Live Worker**: Server Group `live`, subdomain `batch-worker-live.privateauto.com`

## Environment Variables

Each worker environment is configured with:
- `CRONICLE_SERVER_GROUP`: Environment-specific server group
- `CRONICLE_ENVIRONMENT`: Environment identifier
- `WORKER_ENVIRONMENT`: Worker environment identifier

## Docker Configuration

A unified, parameterized docker configuration has been created:
- `docker-unified/` - Single docker-compose.yml with environment-specific configurations
  - `env-configs/master.env` - Master server configuration
  - `env-configs/privateauto.env` - PrivateAuto worker configuration
  - `env-configs/padev.env` - PADev worker configuration
  - `env-configs/dev2.env` - Dev2 worker configuration
  - `env-configs/dev.env` - Dev worker configuration
  - `env-configs/qa.env` - QA worker configuration
  - `env-configs/live.env` - Live worker configuration

This approach eliminates code duplication and provides a single source of truth for docker configuration while maintaining environment-specific settings through parameterization.

## Deployment Commands

To deploy the entire stack including all workers:

```bash
cd iac
npm install
npx sst deploy
```

To deploy to specific stages:

```bash
# Deploy to development
npx sst deploy --stage dev

# Deploy to production
npx sst deploy --stage live
```

## Stack Outputs

After deployment, the following URLs will be available:
- `MainUrl`: Master server URL
- `PrivateAutoWorkerUrl`: PrivateAuto worker URL
- `PADevWorkerUrl`: PADev worker URL

## IAM Permissions

The stack includes IAM permissions for workers to assume roles in both environments:
- `arn:aws:iam::182399724557:role/pa-octopus-oidc-role` (PADev)
- `arn:aws:iam::331322215907:role/pa-octopus-oidc-role` (PrivateAuto)

## Server Group Configuration

Workers are configured to join specific server groups based on their environment, allowing jobs to be targeted to the appropriate environment's infrastructure and credentials.