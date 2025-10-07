#!/usr/bin/env node

/**
 * Cronicle MongoSH Plugin
 * Executes MongoDB shell commands in different environments
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class MongoSHPlugin {
    constructor() {
        this.params = this.parseParams();
        this.validateParams();
    }

    parseParams() {
        // Parse command line arguments
        const args = process.argv.slice(2);
        const params = {};
        
        // Parse --key value pairs
        for (let i = 0; i < args.length; i += 2) {
            if (args[i].startsWith('--')) {
                const key = args[i].substring(2);
                const value = args[i + 1] || '';
                params[key] = value;
            }
        }

        // Also check environment variables (Cronicle style)
        if (process.env.JOB_PARAMS) {
            try {
                const jobParams = JSON.parse(process.env.JOB_PARAMS);
                Object.assign(params, jobParams);
            } catch (err) {
                // Ignore parsing errors
            }
        }

        return {
            target: params.target || 'padev',
            inline_script: params.inline_script || '',
            extra_args: params.extra_args || '',
            quiet: params.quiet === 'true' || params.quiet === true
        };
    }

    validateParams() {
        const validTargets = ['padev', 'privateauto'];
        
        if (!validTargets.includes(this.params.target)) {
            throw new Error(`Invalid target environment: ${this.params.target}. Valid targets: ${validTargets.join(', ')}`);
        }

        if (!this.params.inline_script && !this.params.extra_args) {
            throw new Error('Either inline_script or extra_args must be provided');
        }
    }

    getConnectionString(target) {
        const connections = {
            'padev': 'mongodb://localhost:27017/padev',
            'privateauto': 'mongodb://prod-mongo:27017/privateauto'
        };
        
        return connections[target] || connections['padev'];
    }

    async createTempScript() {
        if (!this.params.inline_script) {
            return null;
        }

        const tmpDir = os.tmpdir();
        const scriptPath = path.join(tmpDir, `cronicle_mongosh_${Date.now()}.js`);
        
        try {
            fs.writeFileSync(scriptPath, this.params.inline_script, 'utf8');
            return scriptPath;
        } catch (err) {
            throw new Error(`Failed to create temporary script: ${err.message}`);
        }
    }

    async execute() {
        const connectionString = this.getConnectionString(this.params.target);
        let tempScriptPath = null;
        
        try {
            // Create temporary script file if needed
            if (this.params.inline_script) {
                tempScriptPath = await this.createTempScript();
            }

            // Build mongosh command
            const args = [connectionString];
            
            // Add script file if created
            if (tempScriptPath) {
                args.push(tempScriptPath);
            }
            
            // Add extra arguments
            if (this.params.extra_args) {
                args.push(...this.params.extra_args.split(' ').filter(arg => arg.trim()));
            }
            
            // Add quiet flag if requested
            if (this.params.quiet) {
                args.push('--quiet');
            }

            if (!this.params.quiet) {
                console.log(`🚀 Executing mongosh with target: ${this.params.target}`);
                console.log(`📝 Command: mongosh ${args.join(' ')}`);
            }

            // Execute mongosh
            return new Promise((resolve, reject) => {
                const child = spawn('mongosh', args, {
                    stdio: 'inherit',
                    env: { ...process.env }
                });

                child.on('close', (code) => {
                    // Clean up temp file
                    if (tempScriptPath) {
                        try {
                            fs.unlinkSync(tempScriptPath);
                        } catch (err) {
                            // Ignore cleanup errors
                        }
                    }

                    if (code === 0) {
                        if (!this.params.quiet) {
                            console.log('✅ MongoSH execution completed successfully');
                        }
                        resolve();
                    } else {
                        reject(new Error(`mongosh exited with code ${code}`));
                    }
                });

                child.on('error', (err) => {
                    // Clean up temp file
                    if (tempScriptPath) {
                        try {
                            fs.unlinkSync(tempScriptPath);
                        } catch (cleanupErr) {
                            // Ignore cleanup errors
                        }
                    }
                    
                    reject(new Error(`Failed to execute mongosh: ${err.message}`));
                });
            });

        } catch (err) {
            // Clean up temp file on error
            if (tempScriptPath) {
                try {
                    fs.unlinkSync(tempScriptPath);
                } catch (cleanupErr) {
                    // Ignore cleanup errors
                }
            }
            throw err;
        }
    }

    printUsage() {
        console.log(`
MongoSH Cronicle Plugin

Usage:
  ${process.argv[0]} ${process.argv[1]} [options]

Options:
  --target <env>           Target environment (padev, privateauto)
  --inline_script <script> JavaScript code to execute
  --extra_args <args>      Additional mongosh arguments
  --quiet                  Suppress output

Environment Variables:
  JOB_PARAMS              JSON string with parameters (Cronicle style)

Examples:
  node mongosh-plugin.js --target padev --inline_script "db.collection('users').count()"
  node mongosh-plugin.js --target privateauto --extra_args "--eval 'printjson({status: 'ok'})'"
`);
    }
}

// Main execution
async function main() {
    try {
        // Handle help flag
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
            const plugin = new MongoSHPlugin();
            plugin.printUsage();
            process.exit(0);
        }

        // For testing mode, simulate mongosh if not available
        if (process.env.MONGO_TEST_MODE === 'true') {
            console.log('🧪 Running in test mode - simulating mongosh execution');
            
            const plugin = new MongoSHPlugin();
            
            // Simulate execution
            console.log(`Target: ${plugin.params.target}`);
            if (plugin.params.inline_script) {
                console.log(`Script: ${plugin.params.inline_script}`);
            }
            if (plugin.params.extra_args) {
                console.log(`Extra args: ${plugin.params.extra_args}`);
            }
            
            console.log('✅ Simulated execution completed');
            process.exit(0);
        }

        const plugin = new MongoSHPlugin();
        await plugin.execute();
        process.exit(0);

    } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = MongoSHPlugin;