const { SSMClient, GetParameterCommand, GetParametersCommand } = require('@aws-sdk/client-ssm');
const Tools = require('pixl-tools');
const Component = require('pixl-server/component');

module.exports = class SecretsManager extends Component {

	__name = 'SecretsManager'

	startup(callback) {
		this.logDebug(3, "Starting up Secrets Manager");

		const awsConfig = this.config.get('AWS') || {};
		this.ssmClient = new SSMClient({
			region: awsConfig.region || 'us-east-1',
			...awsConfig
		});

		this.parameterCache = new Map();
		this.cacheTimeout = this.config.get('secrets_cache_timeout') || 3600; // 1 hour default

		callback();
	}

	shutdown(callback) {
		this.logDebug(3, "Shutting down Secrets Manager");
		if (this.parameterCache) {
			this.parameterCache.clear();
		}
		callback();
	}

	async getParameter(parameterName, withDecryption = true) {
		try {
			// Check cache first
			const cacheKey = `${parameterName}:${withDecryption}`;
			const cached = this.parameterCache.get(cacheKey);

			if (cached && (Date.now() - cached.timestamp) < (this.cacheTimeout * 1000)) {
				this.logDebug(9, `Retrieved parameter from cache: ${parameterName}`);
				return cached.value;
			}

			const command = new GetParameterCommand({
				Name: parameterName,
				WithDecryption: withDecryption
			});

			const response = await this.ssmClient.send(command);
			const value = response.Parameter.Value;

			// Cache the result
			this.parameterCache.set(cacheKey, {
				value: value,
				timestamp: Date.now()
			});

			this.logDebug(5, `Retrieved parameter from SSM: ${parameterName}`);
			return value;

		} catch (error) {
			this.logError('ssm_parameter_error', `Failed to retrieve parameter ${parameterName}: ${error.message}`);
			throw error;
		}
	}

	async getParameters(parameterNames, withDecryption = true) {
		try {
			const uncachedParams = [];
			const cachedResults = {};

			// Check cache for each parameter
			for (const paramName of parameterNames) {
				const cacheKey = `${paramName}:${withDecryption}`;
				const cached = this.parameterCache.get(cacheKey);

				if (cached && (Date.now() - cached.timestamp) < (this.cacheTimeout * 1000)) {
					cachedResults[paramName] = cached.value;
				} else {
					uncachedParams.push(paramName);
				}
			}

			let ssmResults = {};

			// Fetch uncached parameters from SSM
			if (uncachedParams.length > 0) {
				const command = new GetParametersCommand({
					Names: uncachedParams,
					WithDecryption: withDecryption
				});

				const response = await this.ssmClient.send(command);

				// Process successful parameters
				for (const param of response.Parameters) {
					const cacheKey = `${param.Name}:${withDecryption}`;
					this.parameterCache.set(cacheKey, {
						value: param.Value,
						timestamp: Date.now()
					});
					ssmResults[param.Name] = param.Value;
				}

				// Log any invalid parameters
				if (response.InvalidParameters && response.InvalidParameters.length > 0) {
					this.logError('ssm_invalid_parameters', `Invalid parameters: ${response.InvalidParameters.join(', ')}`);
				}
			}

			// Combine cached and fresh results
			const allResults = { ...cachedResults, ...ssmResults };

			this.logDebug(5, `Retrieved ${Object.keys(allResults).length} parameters from SSM`);
			return allResults;

		} catch (error) {
			this.logError('ssm_parameters_error', `Failed to retrieve parameters: ${error.message}`);
			throw error;
		}
	}

	async resolveConfigSecrets(config) {
		try {
			const secretRefs = this.findSecretReferences(config);

			if (secretRefs.length === 0) {
				return config;
			}

			this.logDebug(4, `Found ${secretRefs.length} secret references to resolve`);

			// Extract unique parameter names
			const parameterNames = [...new Set(secretRefs.map(ref => ref.parameterName))];

			// Fetch all parameters at once
			const parameters = await this.getParameters(parameterNames);

			// Replace secret references with actual values
			let resolvedConfig = Tools.copyHash(config, true);

			for (const ref of secretRefs) {
				if (parameters[ref.parameterName]) {
					this.setNestedValue(resolvedConfig, ref.path, parameters[ref.parameterName]);
					this.logDebug(6, `Resolved secret reference: ${ref.reference}`);
				} else {
					this.logError('ssm_secret_not_found', `Secret parameter not found: ${ref.parameterName}`);
				}
			}

			return resolvedConfig;

		} catch (error) {
			this.logError('ssm_config_resolve_error', `Failed to resolve config secrets: ${error.message}`);
			throw error;
		}
	}

	findSecretReferences(obj, path = []) {
		const references = [];

		if (typeof obj === 'string') {
			// Look for SSM parameter references in format: ssm:/parameter/name
			const match = obj.match(/^ssm:\/(.+)$/);
			if (match) {
				references.push({
					reference: obj,
					parameterName: match[1],
					path: path.slice()
				});
			}
		} else if (Array.isArray(obj)) {
			obj.forEach((item, index) => {
				references.push(...this.findSecretReferences(item, [...path, index]));
			});
		} else if (obj && typeof obj === 'object') {
			Object.keys(obj).forEach(key => {
				references.push(...this.findSecretReferences(obj[key], [...path, key]));
			});
		}

		return references;
	}

	setNestedValue(obj, path, value) {
		let current = obj;

		for (let i = 0; i < path.length - 1; i++) {
			current = current[path[i]];
		}

		current[path[path.length - 1]] = value;
	}

	clearCache() {
		this.parameterCache.clear();
		this.logDebug(4, "Cleared secrets cache");
	}

	getCacheStats() {
		return {
			size: this.parameterCache.size,
			timeout: this.cacheTimeout
		};
	}
};