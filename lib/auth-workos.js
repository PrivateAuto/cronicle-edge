// WorkOS Authentication Plugin for Cronicle
// Direct integration with WorkOS APIs
// Copyright (c) 2025
// Released under the MIT License

const assert = require("assert");
const Class = require("pixl-class");
const Component = require("pixl-server/component");
const Tools = require("pixl-tools");
const Request = require('pixl-request');

module.exports = Class.create({

	__name: 'WorkOSAuth',
	__parent: Component,

	defaultConfig: {
		"workos": {
			"enabled": false,
			"api_key": "",
			"client_id": "",
			"client_secret": "",
			"organization_id": "",
			"base_url": "https://api.workos.com",
			"redirect_uri": "http://localhost:3012/api/workos/callback",
			"default_connection": "",
			"auto_create_users": true,
			"user_attribute_mapping": {
				"email": "email",
				"full_name": "first_name last_name",
				"avatar": "profile_picture_url"
			},
			"default_privileges": {
				"admin": 0,
				"create_events": 1,
				"edit_events": 1,
				"delete_events": 1,
				"run_events": 0,
				"abort_events": 0,
				"state_update": 0,
				"disable_enable_events": 0
			}
		}
	},

	startup: function (callback) {
		const self = this;

		this.logDebug(3, "WorkOS Authentication Plugin starting up");

		// register our class as an API namespace
		this.server.API.addNamespace("workos", "api_", this);

		// add local references to other components
		this.storage = this.server.Storage;
		this.web = this.server.WebServer;
		this.user = this.server.User;

		// initialize request module
		this.request = new Request("WorkOS Auth Plugin");

		// WorkOS state management for OAuth flows
		this.auth_state = {};

		// Clear stale auth requests daily
		this.server.on('day', () => {
			self.auth_state = {};
		});

		callback();
	},

	shutdown: function (callback) {
		this.logDebug(3, "WorkOS Authentication Plugin shutting down");
		callback();
	},

	getWorkOSConfig: function () {
		const config = this.server.config.get('workos');

		if (!config || !config.enabled) {
			this.logDebug(3, "WorkOS authentication is disabled");
			return null;
		}

		// Validate required configuration
		const required = ['client_id', 'client_secret', 'organization_id'];
		for (let field of required) {
			if (!config[field]) {
				this.logError(3, `WorkOS config missing required field: ${field}`);
				return null;
			}
		}

		return config;
	},

	// API endpoint to initiate WorkOS SSO login
	api_login: function (args, callback) {
		const self = this;
		const res = args.response;
		const params = Tools.mergeHashes(args.params, args.query);
		const orig_location = params.orig_location || 'Home';

		// Check if user already has a session
		const session_id = args.cookies['session_id'] || args.request.headers['x-session-id'] || args.params.session_id || args.query.session_id;
		if (session_id) {
			this.logDebug(3, 'User already has session, redirecting', session_id);
			res.writeHead(302, { Location: this.getBaseLocation('#' + orig_location) });
			return res.end();
		}

		const config = this.getWorkOSConfig();
		if (!config) {
			return callback({ Code: 500, Description: "WorkOS is not configured" });
		}

		// Generate state parameter for security
		const state = Tools.generateUniqueID(16) + '.' + orig_location;
		this.auth_state[state] = {
			created: Date.now(),
			orig_location: orig_location
		};

		// Build WorkOS authorization URL
		const authUrl = new URL(`${config.base_url}/sso/authorize`);
		authUrl.searchParams.set('client_id', config.client_id);
		authUrl.searchParams.set('redirect_uri', config.redirect_uri);
		authUrl.searchParams.set('response_type', 'code');
		authUrl.searchParams.set('state', state);

		// Add organization parameter if specified
		if (config.organization_id) {
			authUrl.searchParams.set('organization', config.organization_id);
		}

		// Add connection parameter if specified
		if (config.default_connection) {
			authUrl.searchParams.set('connection', config.default_connection);
		}

		this.logDebug(3, "Redirecting to WorkOS SSO", authUrl.toString());
		res.writeHead(302, { Location: authUrl.toString() });
		res.end();
	},

	// API endpoint to handle WorkOS callback
	api_callback: async function (args, callback) {
		const self = this;
		const params = Tools.mergeHashes(args.params, args.query);

		// Validate required parameters
		if (!this.requireParams(params, {
			code: /.+/,
			state: /.+/
		}, callback)) return;

		const { code, state } = params;

		// Validate state parameter
		if (!this.auth_state[state]) {
			this.logError(3, 'Invalid WorkOS auth state:', state);
			return this.doError('login', "Invalid authentication state", callback);
		}

		const orig_location = this.auth_state[state].orig_location || 'Home';
		delete this.auth_state[state]; // Clean up state

		const config = this.getWorkOSConfig();
		if (!config) {
			return this.doError('login', "WorkOS is not configured", callback);
		}

		try {
			// Exchange authorization code for access token
			const tokenData = await this.exchangeCodeForToken(code, config);

			// Get user profile from WorkOS
			const userProfile = await this.getUserProfile(tokenData.access_token, config);

			// Process user login/creation
			const user = await this.processUserLogin(userProfile, config);

			// Create session and redirect
			await this.createUserSession(user, args, orig_location, callback);

		} catch (error) {
			this.logError(3, 'WorkOS authentication failed:', error.message);
			return this.doError('login', "Authentication failed: " + error.message, callback);
		}
	},

	exchangeCodeForToken: async function (code, config) {
		const tokenUrl = `${config.base_url}/sso/token`;

		const tokenData = {
			client_id: config.client_id,
			client_secret: config.client_secret,
			code: code,
			grant_type: 'authorization_code',
			redirect_uri: config.redirect_uri
		};

		this.logDebug(3, 'Requesting WorkOS access token');

		return new Promise((resolve, reject) => {
			this.request.json(tokenUrl, tokenData, (err, response, data) => {
				if (err) {
					return reject(new Error('Token request failed: ' + err.message));
				}

				if (!data || !data.access_token) {
					this.logError(3, 'Invalid token response:', data);
					return reject(new Error('Invalid token response'));
				}

				resolve(data);
			});
		});
	},

	getUserProfile: async function (accessToken, config) {
		const profileUrl = `${config.base_url}/sso/profile`;

		this.logDebug(3, 'Requesting WorkOS user profile');

		return new Promise((resolve, reject) => {
			this.request.json(profileUrl, {
				headers: {
					'Authorization': 'Bearer ' + accessToken,
					'Accept': 'application/json'
				}
			}, (err, response, data) => {
				if (err) {
					return reject(new Error('Profile request failed: ' + err.message));
				}

				if (!data || !data.email) {
					this.logError(3, 'Invalid profile response:', data);
					return reject(new Error('Invalid profile response'));
				}

				resolve(data);
			});
		});
	},

	processUserLogin: async function (profile, config) {
		const self = this;
		const mapping = config.user_attribute_mapping || {};

		// Extract user data using attribute mapping
		const email = this.getNestedProperty(profile, mapping.email || 'email');
		const fullName = this.buildFullName(profile, mapping.full_name || 'first_name last_name');
		const avatar = this.getNestedProperty(profile, mapping.avatar || 'profile_picture_url');

		if (!email) {
			throw new Error('No email found in WorkOS profile');
		}

		const username = this.user.normalizeUsername(email);
		const userPath = 'users/' + username;

		// Check if user exists
		let user = await this.getUserAsync(userPath);

		if (!user && config.auto_create_users) {
			// Create new user
			this.logDebug(3, 'Creating new user from WorkOS profile:', email);

			user = {
				username: username,
				email: email,
				full_name: fullName || email,
				active: true,
				created: Tools.timeNow(),
				modified: Tools.timeNow(),
				avatar: avatar || '',
				workos_profile: profile,
				privileges: config.default_privileges || {}
			};

			await this.storeUserAsync(userPath, user);
		} else if (!user) {
			throw new Error('User does not exist and auto-creation is disabled');
		}

		if (!user.active) {
			throw new Error('User account is disabled');
		}

		// Update user profile data from WorkOS
		user.workos_profile = profile;
		user.modified = Tools.timeNow();
		if (avatar) user.avatar = avatar;
		if (fullName) user.full_name = fullName;

		await this.storeUserAsync(userPath, user);

		return user;
	},

	createUserSession: async function (user, args, orig_location, callback) {
		const self = this;
		const sessionExpireDays = this.server.config.get('session_expire_days') || 30;

		// Create session using the existing user component's session logic
		const session = {
			id: Tools.generateUniqueID(64),
			username: user.username,
			user: user,
			type: 'user',
			ip: args.ip,
			useragent: args.request.headers['user-agent'] || '',
			created: Tools.timeNow(),
			modified: Tools.timeNow()
		};

		// Store session
		await this.storeSessionAsync('sessions/' + session.id, session);

		// Set session cookie
		const cookie_ttl = sessionExpireDays * 24 * 60 * 60 * 1000;
		args.response.setHeader('Set-Cookie', [
			'session_id=' + session.id + '; HttpOnly; Path=/; Max-Age=' + Math.floor(cookie_ttl / 1000)
		]);

		this.logDebug(3, 'WorkOS login successful for user:', user.username);

		// Redirect to original location
		const redirectUrl = this.getBaseLocation('#' + orig_location);
		args.response.writeHead(302, { Location: redirectUrl });
		args.response.end();
	},

	// Helper methods
	getNestedProperty: function (obj, path) {
		return path.split('.').reduce((current, key) => current && current[key], obj);
	},

	buildFullName: function (profile, template) {
		if (!template) return '';

		return template.replace(/\b\w+\b/g, (match) => {
			return this.getNestedProperty(profile, match) || '';
		}).replace(/\s+/g, ' ').trim();
	},

	getUserAsync: function (path) {
		const self = this;
		return new Promise((resolve, reject) => {
			self.storage.get(path, (err, user) => {
				if (err && err.code !== 'NoSuchKey') {
					return reject(err);
				}
				resolve(user || null);
			});
		});
	},

	storeUserAsync: function (path, user) {
		const self = this;
		return new Promise((resolve, reject) => {
			self.storage.put(path, user, (err) => {
				if (err) return reject(err);
				resolve();
			});
		});
	},

	storeSessionAsync: function (path, session) {
		const self = this;
		return new Promise((resolve, reject) => {
			self.storage.put(path, session, (err) => {
				if (err) return reject(err);
				resolve();
			});
		});
	},

	getBaseLocation: function (hash = '') {
		const config = this.server.config.get();
		const protocol = config.https ? 'https://' : 'http://';
		const hostname = config.base_app_url ? config.base_app_url.replace(/^https?:\/\//, '') : 'localhost:3012';
		return protocol + hostname + hash;
	},

	doError: function (type, msg, callback) {
		callback({ code: 0, description: msg });
	},

	requireParams: function (params, rules, callback) {
		for (let key in rules) {
			if (!(key in params) || !params[key].toString().match(rules[key])) {
				this.doError('api', `Missing or invalid parameter: ${key}`, callback);
				return false;
			}
		}
		return true;
	}
});