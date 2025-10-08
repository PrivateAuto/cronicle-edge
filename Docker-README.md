# Unified Cronicle Docker Configuration

This directory contains a unified, parameterized Docker configuration that can be used for all Cronicle deployments (master and worker environments). Environment variables are automatically populated by the IaC deployment process.

## Structure

```
docker-unified/
├── docker-compose.yml          # Parameterized docker-compose file
├── .platform/                # Elastic Beanstalk platform configuration
└── .ebextensions/            # Elastic Beanstalk extensions
```

## Usage

Environment variables are automatically set by the IaC deployment process. For local testing:

```bash
# Set required variables manually
export TAG=latest
export AWS_REGION=us-east-2
export TZ=America/Chicago
export CRONICLE_base_app_url=https://batch.paops.xyz
export CRONICLE_SERVER_GROUP=test
export CRONICLE_ENVIRONMENT=test
export WORKER_ENVIRONMENT=test
export CRONICLE_CLUSTER_ROLE=worker
export CRONICLE_server_comm_use_hostnames=1
export CRONICLE_web_direct_connect=0

# Run docker-compose
docker-compose up -d
```

## Environment Variables

The following environment variables are automatically set by the IaC deployment:

- `AWS_REGION`: AWS region for the deployment
- `TZ`: Timezone setting (America/Chicago)
- `CRONICLE_base_app_url`: Base URL for the Cronicle master server
- `CRONICLE_SERVER_GROUP`: Server group identifier (derived from environment)
- `CRONICLE_ENVIRONMENT`: Environment identifier (derived from environment)
- `WORKER_ENVIRONMENT`: Worker environment identifier (derived from environment)
- `CRONICLE_CLUSTER_ROLE`: master or worker (derived from deployment type)
- `CRONICLE_server_comm_use_hostnames`: Always set to "1"
- `CRONICLE_web_direct_connect`: Direct web connection setting (1 for master, 0 for worker)

**Note**: All values are automatically populated from the centralized configuration in `iac/stacks/env-configs.ts`, ensuring consistency across all deployments.

## Benefits of Unified Configuration

1. **Single Source of Truth**: One docker-compose.yml for all environments
2. **Easy Maintenance**: Changes apply to all environments automatically
3. **Centralized Configuration**: All environment-specific values managed in IaC
4. **Flexible Deployment**: Can be used locally, in CI/CD, or in production
5. **Reduced Duplication**: No need for multiple docker directories or env files

## Integration with IaC

The Infrastructure as Code (IaC) configuration automatically uses this unified docker setup with centralized configuration management:

1. **Environment Configuration**: All Cronicle-specific settings are defined in `iac/stacks/env-configs.ts`
2. **Automatic Population**: During deployment, the IaC automatically populates environment variables from the centralized configuration
3. **Consistency**: Ensures all deployments use the same configuration values without duplication
4. **Single Source of Truth**: All environment-specific values are managed in one place

### Configuration Flow:
1. Define environment settings in `iac/stacks/env-configs.ts`
2. IaC calls `getCronicleEnvironmentVars()` to get the appropriate configuration
3. Values are automatically injected into the Docker environment during deployment
4. Docker containers start with the correct environment-specific configuration