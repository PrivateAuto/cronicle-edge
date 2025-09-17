#!/usr/bin/env node

// Cronicle Server - Main entry point
// Copyright (c) 2015 - 2025 Joseph Huckaby
// Released under the MIT License

// Error out if Node.js version is old
if (process.version.match(/^v?(\d+)/) && (parseInt(RegExp.$1) < 16) && !process.env['CRONICLE_OLD']) {
	console.error("\nERROR: You are using an incompatible version of Node.js (" + process.version + ").  Please upgrade to v16 or later.  Instructions: https://nodejs.org/en/download/package-manager\n\nTo ignore this error and run unsafely, set a CRONICLE_OLD environment variable.  Do this at your own risk.\n");
	process.exit(1);
}

const PixlServer = require("pixl-server");
const fs = require('fs');

// chdir to the proper server root dir
process.chdir( require('path').dirname( __dirname ) );

// resolve secret key and config file
let secret_key_file = process.env['CRONICLE_secret_key_file'] || 'conf/secret_key';
if(!process.env['CRONICLE_secret_key'] && fs.existsSync(secret_key_file)) {
	process.env['CRONICLE_secret_key'] = fs.readFileSync(secret_key_file).toString().trim();
}

let configFiles = []

let config_file = process.env['CRONICLE_config_file'] || 'conf/config.json'
if(fs.existsSync(config_file)) configFiles.push( { 
	file: config_file
})

// override storage config if needed
if (process.env['CRONICLE_sqlite']) { // use sqlite
	process.env["CRONICLE_Storage__engine"] = "SQL"
	process.env["CRONICLE_Storage__SQL__connection__filename"] = process.env['CRONICLE_sqlite']
	process.env["CRONICLE_Storage__SQL__client"] = "sqlite3"
	process.env["CRONICLE_Storage__SQL__table"] = "cronicle"
	process.env["CRONICLE_Storage__SQL__useNullAsDefault"] = 1
}
else if (process.env['CRONICLE_sqlstring']) { // use connection string variable
	let cs = new URL(process.env['CRONICLE_sqlstring'])
	let map = {
		  'pg:':'pg', 'postgres:':'pg', 'pgsql:':'pg'
		, 'mysql:':'mysql2', 'mysql2:':'mysql2'
		, 'oracle:':'oracledb', 'oracledb:':'oracledb'
		, 'mssql:':'mssql'
	}

	// check if the protocol is one of those accepted
	let driver = map[cs['protocol']]
	if(!driver) throw new Error(`Invalid Driver, use on of the following ${Object.keys(map).map(e=>e.slice(0,-1))}`)

	process.env["CRONICLE_Storage__engine"] = "SQL"
	process.env["CRONICLE_Storage__SQL__client"] = driver
	process.env["CRONICLE_Storage__SQL__table"] = cs['searchParams'].get('table') || 'cronicle'
	process.env["CRONICLE_Storage__SQL__useNullAsDefault"] = 1
	process.env["CRONICLE_Storage__SQL__connection__host"] = cs['hostname']
	process.env["CRONICLE_Storage__SQL__connection__port"] = cs['port'] || ''
	process.env["CRONICLE_Storage__SQL__connection__user"] = cs['username']
	process.env["CRONICLE_Storage__SQL__connection__password"] = process.env['CRONICLE_sqlpassword'] || decodeURIComponent(cs['password'])
	process.env["CRONICLE_Storage__SQL__connection__database"] = cs['pathname'].slice(1)
}
else if (process.env['CRONICLE_postgres_host']) { // use postgres variables
	process.env["CRONICLE_Storage__engine"] = "SQL"
	process.env["CRONICLE_Storage__SQL__client"] = "pg"
	process.env["CRONICLE_Storage__SQL__table"] = "cronicle"
	process.env["CRONICLE_Storage__SQL__useNullAsDefault"] = 1
	process.env["CRONICLE_Storage__SQL__connection__host"] = process.env['CRONICLE_postgres_host']
	process.env["CRONICLE_Storage__SQL__connection__port"] = parseInt(process.env['CRONICLE_postgres_port']) || 5432
	process.env["CRONICLE_Storage__SQL__connection__user"] = process.env['CRONICLE_postgres_username']
	process.env["CRONICLE_Storage__SQL__connection__password"] = process.env['CRONICLE_postgres_password'] || process.env['CRONICLE_sqlpassword']
	process.env["CRONICLE_Storage__SQL__connection__database"] = process.env['CRONICLE_postgres_db']
}
else {  // or resolve storage config from files
	let storage_config = process.env['CRONICLE_storage_config'] || "conf/storage.json"
	if (fs.existsSync(storage_config)) configFiles.push({
		file: storage_config, key: "Storage"
	})
}

const server = new PixlServer({
	
	__name: 'Cronicle',
	__version: process.env['CRONICLE_dev_version'] || require('../package.json').version,
	
	// configFile: config_file,
	multiConfig: configFiles,
	
	components: [
		require('./secrets-manager.js'),
		require('pixl-server-storage'),
		require('pixl-server-web'),
		require('pixl-server-api'),
		require('./user.js'),
		require('./auth-workos.js'),
		require('./engine.js')
	]
	
});

server.startup( async function() {
	// Resolve SSM secrets in configuration after startup
	try {
		const secretsManager = server.SecretsManager;
		if (secretsManager) {
			server.logDebug(3, "Resolving SSM secrets in configuration");
			const resolvedConfig = await secretsManager.resolveConfigSecrets(server.config.get());

			// Update the configuration with resolved secrets
			Object.keys(resolvedConfig).forEach(key => {
				server.config.set(key, resolvedConfig[key]);
			});

			server.logDebug(3, "SSM secrets resolution complete");
		}
	} catch (error) {
		server.logError('startup', `Failed to resolve SSM secrets: ${error.message}`);
		// Continue startup even if secret resolution fails
	}

	// server startup complete
	process.title = server.__name + ' Server';
} );
