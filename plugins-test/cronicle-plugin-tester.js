#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');

class CroniclePluginTester {
    constructor() {
        this.testResults = [];
        this.verbose = false;
        this.timeout = 30000; // 30 second default timeout
        this.enableSyntaxTesting = false; // Default syntax testing to false
        this.echoStdin = false; // Default stdin echoing to false
    }

    log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const prefix = {
            'info': '📝',
            'success': '✅',
            'error': '❌',
            'warn': '⚠️',
            'debug': '🔍'
        }[level] || 'ℹ️';
        
        if (level !== 'debug' || this.verbose) {
            console.log(`${prefix} [${timestamp}] ${message}`);
        }
    }

    // Simulate Cronicle environment variables and context
    setupCronicleEnvironment(jobData = {}) {
        const defaultJob = {
            id: 'test_job_' + Date.now(),
            title: 'Test Job',
            username: 'admin',
            params: {},
            category: 'general',
            target: 'localhost',
            ...jobData
        };

        // Set environment variables that Cronicle typically provides
        process.env.JOB_ID = defaultJob.id;
        process.env.JOB_TITLE = defaultJob.title;
        process.env.JOB_USERNAME = defaultJob.username;
        process.env.JOB_CATEGORY = defaultJob.category;
        process.env.JOB_TARGET = defaultJob.target;
        process.env.JOB_PARAMS = JSON.stringify(defaultJob.params);
        process.env.CRONICLE_BASE_DIR = process.cwd();

        return defaultJob;
    }

    // Parse JavaScript syntax errors and provide detailed line information
    parseSyntaxError(error, content) {
        const lines = content.split('\n');
        let errorDetails = `JavaScript syntax error: ${error.message}`;
        
        // Only show detailed line information in verbose mode
        if (!this.verbose) {
            return errorDetails;
        }
        
        // Try to extract line number from error message
        const lineMatch = error.message.match(/(?:line|Line)\s+(\d+)/i);
        if (lineMatch) {
            const lineNum = parseInt(lineMatch[1]);
            errorDetails += `\n    at line ${lineNum}`;
            
            // Show context around the error
            const context = this.getErrorContext(lines, lineNum);
            if (context) {
                errorDetails += `\n${context}`;
            }
        } else {
            // Try alternative patterns for line number extraction
            const altPatterns = [
                /(\d+):(\d+)/,  // line:column format
                /position (\d+)/i,  // position format
                /offset (\d+)/i     // offset format
            ];
            
            for (const pattern of altPatterns) {
                const match = error.message.match(pattern);
                if (match) {
                    const position = parseInt(match[1]);
                    
                    if (error.message.includes(':')) {
                        // This looks like line:column
                        const lineNum = position;
                        errorDetails += `\n    at line ${lineNum}`;
                        
                        const context = this.getErrorContext(lines, lineNum);
                        if (context) {
                            errorDetails += `\n${context}`;
                        }
                    } else {
                        // Try to convert position/offset to line number
                        const lineNum = this.getLineFromPosition(content, position);
                        if (lineNum > 0) {
                            errorDetails += `\n    at approximate line ${lineNum}`;
                            
                            const context = this.getErrorContext(lines, lineNum);
                            if (context) {
                                errorDetails += `\n${context}`;
                            }
                        }
                    }
                    break;
                }
            }
        }
        
        // If we still couldn't find a line number, try a more advanced approach
        if (!errorDetails.includes('line') && this.verbose) {
            const advancedResult = this.advancedSyntaxAnalysis(content, error);
            if (advancedResult) {
                errorDetails += `\n${advancedResult}`;
            }
        }
        
        return errorDetails;
    }

    // Get error context showing lines around the error
    getErrorContext(lines, lineNum, contextLines = 2) {
        if (lineNum < 1 || lineNum > lines.length) {
            return null;
        }
        
        const startLine = Math.max(1, lineNum - contextLines);
        const endLine = Math.min(lines.length, lineNum + contextLines);
        
        let context = '    Code context:';
        
        for (let i = startLine; i <= endLine; i++) {
            const line = lines[i - 1] || '';
            const linePrefix = i === lineNum ? '>>> ' : '    ';
            const lineNumStr = i.toString().padStart(3, ' ');
            context += `\n    ${lineNumStr}${linePrefix}${line}`;
            
            // Add indicator arrow for the error line
            if (i === lineNum) {
                context += `\n       ${'^'.repeat(Math.min(line.length, 40))}`;
            }
        }
        
        return context;
    }

    // Convert character position to line number
    getLineFromPosition(content, position) {
        if (position < 0 || position > content.length) {
            return -1;
        }
        
        const beforeError = content.substring(0, position);
        return beforeError.split('\n').length;
    }

    // Advanced syntax analysis using multiple validation approaches
    advancedSyntaxAnalysis(content, originalError) {
        try {
            // Try parsing with different approaches to get better error info
            
            // 1. Try with eval (might give different error info)
            try {
                eval(`(function() { ${content} })`);
            } catch (evalError) {
                const evalResult = this.extractLineFromError(evalError, content);
                if (evalResult) {
                    return `Advanced analysis suggests error ${evalResult}`;
                }
            }
            
            // 2. Try parsing line by line to isolate the problematic area
            const lines = content.split('\n');
            let problematicLines = [];
            
            for (let i = 0; i < lines.length; i++) {
                const partialContent = lines.slice(0, i + 1).join('\n');
                try {
                    new Function(partialContent);
                } catch (err) {
                    if (err.message !== originalError.message) {
                        problematicLines.push(i + 1);
                        break;
                    }
                }
            }
            
            if (problematicLines.length > 0) {
                const lineNum = problematicLines[0];
                const context = this.getErrorContext(lines, lineNum);
                return `Line-by-line analysis suggests error around line ${lineNum}${context ? '\n' + context : ''}`;
            }
            
            // 3. Check for common syntax issues
            const commonIssues = this.detectCommonSyntaxIssues(content);
            if (commonIssues.length > 0) {
                return `Potential issues detected:\n${commonIssues.map(issue => `    - ${issue}`).join('\n')}`;
            }
            
        } catch (analysisError) {
            // If advanced analysis fails, just return original error info
            return null;
        }
        
        return null;
    }

    // Extract line information from various error formats
    extractLineFromError(error, content) {
        const message = error.message;
        const stack = error.stack || '';
        
        // Look for line numbers in stack trace
        const stackMatch = stack.match(/<anonymous>:(\d+):(\d+)/);
        if (stackMatch) {
            const lineNum = parseInt(stackMatch[1]);
            const colNum = parseInt(stackMatch[2]);
            const lines = content.split('\n');
            const context = this.getErrorContext(lines, lineNum);
            return `at line ${lineNum}, column ${colNum}${context ? '\n' + context : ''}`;
        }
        
        return null;
    }

    // Detect common JavaScript syntax issues
    detectCommonSyntaxIssues(content) {
        const issues = [];
        const lines = content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;
            
            // Check for common issues
            if (line.includes('function(') && !line.includes(')')) {
                issues.push(`Possible unclosed function parameter list at line ${lineNum}`);
            }
            
            if (line.includes('{') && !line.includes('}')) {
                const openBraces = (line.match(/{/g) || []).length;
                const closeBraces = (line.match(/}/g) || []).length;
                if (openBraces > closeBraces) {
                    issues.push(`Possible unclosed brace at line ${lineNum}`);
                }
            }
            
            if (line.includes('[') && !line.includes(']')) {
                const openBrackets = (line.match(/\[/g) || []).length;
                const closeBrackets = (line.match(/\]/g) || []).length;
                if (openBrackets > closeBrackets) {
                    issues.push(`Possible unclosed bracket at line ${lineNum}`);
                }
            }
            
            if (line.includes('(') && !line.includes(')')) {
                const openParens = (line.match(/\(/g) || []).length;
                const closeParens = (line.match(/\)/g) || []).length;
                if (openParens > closeParens) {
                    issues.push(`Possible unclosed parenthesis at line ${lineNum}`);
                }
            }
            
            // Check for unterminated strings
            const singleQuotes = (line.match(/'/g) || []).length;
            const doubleQuotes = (line.match(/"/g) || []).length;
            const backticks = (line.match(/`/g) || []).length;
            
            if (singleQuotes % 2 !== 0) {
                issues.push(`Possible unterminated string (single quotes) at line ${lineNum}`);
            }
            if (doubleQuotes % 2 !== 0) {
                issues.push(`Possible unterminated string (double quotes) at line ${lineNum}`);
            }
            if (backticks % 2 !== 0) {
                issues.push(`Possible unterminated template literal at line ${lineNum}`);
            }
            
            // Check for missing semicolons in obvious places
            if (line.trim().match(/^(var|let|const|return)\s+.*[^;{}]$/)) {
                issues.push(`Possible missing semicolon at line ${lineNum}`);
            }
        }
        
        return issues;
    }

    // Validate plugin file structure
    async validatePluginStructure(pluginPath) {
        this.log(`Validating plugin structure: ${pluginPath}`, 'info');
        
        const results = {
            fileExists: false,
            isExecutable: false,
            syntaxValid: false,
            hasShebang: false,
            errors: []
        };

        try {
            // Check if file exists
            if (!fs.existsSync(pluginPath)) {
                results.errors.push('Plugin file does not exist');
                return results;
            }
            results.fileExists = true;

            // Check if file is executable
            try {
                fs.accessSync(pluginPath, fs.constants.X_OK);
                results.isExecutable = true;
            } catch (err) {
                results.errors.push('Plugin file is not executable');
            }

            // Read file content
            const content = fs.readFileSync(pluginPath, 'utf8');
            
            // Check for shebang
            if (content.startsWith('#!')) {
                results.hasShebang = true;
            } else {
                results.errors.push('Missing shebang line (#!/usr/bin/env node or similar)');
            }

            // Basic syntax validation for JavaScript files
            if (pluginPath.endsWith('.js') && this.enableSyntaxTesting) {
                try {
                    // Simple syntax check - try to parse as module
                    new Function(content);
                    results.syntaxValid = true;
                } catch (err) {
                    const syntaxError = this.parseSyntaxError(err, content);
                    results.errors.push(syntaxError);
                }
            } else {
                results.syntaxValid = true; // Skip syntax validation or assume valid for non-JS files
                if (pluginPath.endsWith('.js') && !this.enableSyntaxTesting) {
                    this.log('Skipping JavaScript syntax validation (use --syntax-check to enable)', 'debug');
                }
            }

        } catch (err) {
            results.errors.push(`Validation error: ${err.message}`);
        }

        // Log results
        if (results.errors.length === 0) {
            this.log('Plugin structure validation passed', 'success');
        } else {
            this.log('Plugin structure validation failed:', 'error');
            results.errors.forEach(error => {
                const isMultiLine = error.includes('\n');
                if (isMultiLine) {
                    this.log(`${error}`, 'error');
                } else {
                    this.log(`  - ${error}`, 'error');
                }
            });
        }

        return results;
    }

    // Test plugin execution with various parameter combinations
    async testPluginExecution(pluginPath, testCases = []) {
        this.log(`Testing plugin execution: ${pluginPath}`, 'info');
        
        const results = [];
        
        // Default test case if none provided
        if (testCases.length === 0) {
            testCases = [{ name: 'default', params: {} }];
        }

        for (const testCase of testCases) {
            this.log(`Running test case: ${testCase.name}`, 'info');
            this.log(`Test case params: ${JSON.stringify(testCase.params || {})}`, 'debug');
            
            const jobData = {
                params: testCase.params || {},
                ...testCase.jobOverrides
            };
            
            this.setupCronicleEnvironment(jobData);
            
            const result = await this.executePlugin(pluginPath, testCase);
            result.testCase = testCase.name;
            results.push(result);
            
            if (result.success) {
                this.log(`Test case '${testCase.name}' passed`, 'success');
            } else {
                this.log(`Test case '${testCase.name}' failed: ${result.error}`, 'error');
            }
        }

        return results;
    }

    // Execute plugin and capture output
    async executePlugin(pluginPath, testCase) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            let stdout = '';
            let stderr = '';
            
            // Prepare arguments (command line args separate from parameters)
            const args = testCase.args || [];
            
            // Prepare JSON payload for stdin (Cronicle specification)
            const jsonPayload = {
                params: testCase.params || {},
                job: {
                    id: process.env.JOB_ID || 'test_job_' + Date.now(),
                    title: process.env.JOB_TITLE || 'Test Job',
                    username: process.env.JOB_USERNAME || 'admin',
                    category: process.env.JOB_CATEGORY || 'general',
                    target: process.env.JOB_TARGET || 'localhost',
                    ...testCase.jobOverrides
                }
            };

            this.log(`Executing: ${pluginPath} ${args.join(' ')}`, 'debug');
            this.log(`Prepared JSON payload with params: ${JSON.stringify(jsonPayload.params)}`, 'debug');
            if (this.verbose) {
                this.log(`Complete JSON payload: ${JSON.stringify(jsonPayload, null, 2)}`, 'debug');
            } else {
                this.log(`Complete JSON payload: ${JSON.stringify(jsonPayload)}`, 'debug');
            }

            const child = spawn(pluginPath, args, {
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Send compact JSON payload to stdin as per Cronicle specification
            const jsonString = JSON.stringify(jsonPayload) + '\n';
            
            // Echo stdin to stdout if requested
            if (this.echoStdin) {
                console.log(`📥 STDIN → Plugin:`);
                if (this.verbose) {
                    console.log(JSON.stringify(jsonPayload, null, 2));
                } else {
                    console.log(jsonString.trim());
                }
                console.log(''); // Add spacing
            }
            
            try {
                child.stdin.write(jsonString);
                child.stdin.end();
                this.log(`Successfully sent ${jsonString.length} bytes to plugin stdin`, 'debug');
            } catch (stdinError) {
                this.log(`Error writing to plugin stdin: ${stdinError.message}`, 'error');
            }

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            const timeoutId = setTimeout(() => {
                child.kill('SIGKILL');
                resolve({
                    success: false,
                    exitCode: -1,
                    stdout,
                    stderr,
                    duration: Date.now() - startTime,
                    sentParams: testCase.params || {}, // Track what params were sent
                    error: 'Execution timeout'
                });
            }, this.timeout);

            child.on('close', (exitCode) => {
                clearTimeout(timeoutId);
                const duration = Date.now() - startTime;
                
                resolve({
                    success: exitCode === 0,
                    exitCode,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    duration,
                    sentParams: testCase.params || {}, // Track what params were sent
                    error: exitCode !== 0 ? `Non-zero exit code: ${exitCode}` : null
                });
            });

            child.on('error', (err) => {
                clearTimeout(timeoutId);
                resolve({
                    success: false,
                    exitCode: -1,
                    stdout,
                    stderr,
                    duration: Date.now() - startTime,
                    sentParams: testCase.params || {}, // Track what params were sent
                    error: `Execution error: ${err.message}`
                });
            });
        });
    }

    // Load test configuration from JSON file
    loadTestConfig(configPath) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            this.log(`Loaded test configuration from ${configPath}`, 'success');
            
            // Validate test cases have proper structure
            if (config.testCases && Array.isArray(config.testCases)) {
                config.testCases.forEach((testCase, index) => {
                    if (!testCase.name) {
                        this.log(`Warning: Test case ${index} missing 'name' field`, 'warn');
                        testCase.name = `test_case_${index}`;
                    }
                    if (testCase.params === undefined) {
                        this.log(`Info: Test case '${testCase.name}' has no params, using empty object`, 'debug');
                        testCase.params = {};
                    }
                    this.log(`Test case '${testCase.name}' params: ${JSON.stringify(testCase.params)}`, 'debug');
                });
            } else {
                this.log('Warning: No valid testCases array found in config', 'warn');
                config.testCases = [];
            }
            
            return config;
        } catch (err) {
            this.log(`Failed to load test config: ${err.message}`, 'error');
            return null;
        }
    }

    // Generate test report
    generateReport(pluginPath, validationResults, executionResults) {
        const report = {
            plugin: pluginPath,
            timestamp: new Date().toISOString(),
            validation: validationResults,
            execution: executionResults,
            summary: {
                validationPassed: validationResults.errors.length === 0,
                totalTests: executionResults.length,
                passedTests: executionResults.filter(r => r.success).length,
                failedTests: executionResults.filter(r => !r.success).length
            }
        };

        return report;
    }

    // Print detailed report
    printReport(report) {
        console.log('\n' + '='.repeat(80));
        console.log('CRONICLE PLUGIN TEST REPORT');
        console.log('='.repeat(80));
        console.log(`Plugin: ${report.plugin}`);
        console.log(`Timestamp: ${report.timestamp}`);
        console.log('');

        // Validation Results
        console.log('VALIDATION RESULTS:');
        console.log(`✓ File exists: ${report.validation.fileExists}`);
        console.log(`✓ Executable: ${report.validation.isExecutable}`);
        console.log(`✓ Has shebang: ${report.validation.hasShebang}`);
        
        if (this.enableSyntaxTesting) {
            console.log(`✓ Syntax valid: ${report.validation.syntaxValid}`);
        } else {
            console.log(`- Syntax check: skipped (use --syntax-check to enable)`);
        }
        
        if (report.validation.errors.length > 0) {
            console.log('\nValidation Errors:');
            report.validation.errors.forEach(error => {
                console.log(`  ❌ ${error}`);
                // Add extra spacing for multi-line errors (like verbose syntax errors with context)
                if (error.includes('\n')) {
                    console.log('');
                }
            });
            
            // Show hint about verbose mode if not already enabled and errors are present
            if (!this.verbose && report.validation.errors.some(e => e.includes('JavaScript syntax error'))) {
                console.log(`\n  💡 Use --verbose flag to see detailed line-by-line syntax error information`);
            }
            
            // Show hint about syntax checking if not enabled and this is a JS file
            if (!this.enableSyntaxTesting && report.plugin.endsWith('.js')) {
                console.log(`\n  💡 Use --syntax-check flag to enable JavaScript syntax validation`);
            }
        }

        // Execution Results
        console.log('\nEXECUTION RESULTS:');
        report.execution.forEach((result, index) => {
            const status = result.success ? '✅ PASS' : '❌ FAIL';
            console.log(`\nTest ${index + 1}: ${result.testCase} - ${status}`);
            
            // Show what params were sent for this test case
            if (this.verbose && report.execution[index].sentParams) {
                console.log(`  Params Sent: ${JSON.stringify(report.execution[index].sentParams)}`);
            }
            
            console.log(`  Exit Code: ${result.exitCode}`);
            console.log(`  Duration: ${result.duration}ms`);
            
            if (result.stdout) {
                console.log(`  STDOUT:\n    ${result.stdout.replace(/\n/g, '\n    ')}`);
            }
            
            if (result.stderr) {
                console.log(`  STDERR:\n    ${result.stderr.replace(/\n/g, '\n    ')}`);
            }
            
            if (result.error) {
                console.log(`  Error: ${result.error}`);
            }
        });

        // Summary
        console.log('\nSUMMARY:');
        console.log(`Validation: ${report.summary.validationPassed ? 'PASSED' : 'FAILED'}`);
        console.log(`Tests: ${report.summary.passedTests}/${report.summary.totalTests} passed`);
        console.log('='.repeat(80));
    }

    // Interactive mode for testing plugins
    async interactiveMode() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

        try {
            console.log('🚀 Cronicle Plugin Interactive Test Mode');
            console.log('Type "help" for available commands, "exit" to quit\n');

            while (true) {
                const command = await question('cronicle-test> ');
                
                if (command === 'exit') {
                    break;
                } else if (command === 'help') {
                    console.log(`
Available commands:
  test <plugin-path> [config-file]  - Test a plugin
  validate <plugin-path>           - Only validate plugin structure
  list-env                         - Show current environment variables
  set-timeout <ms>                 - Set execution timeout
  toggle-verbose                   - Toggle verbose logging
  toggle-syntax-check              - Toggle JavaScript syntax checking
  toggle-echo-stdin                - Toggle echoing stdin to stdout
  help                             - Show this help
  exit                             - Exit interactive mode
`);
                } else if (command.startsWith('test ')) {
                    const parts = command.split(' ');
                    const pluginPath = parts[1];
                    const configFile = parts[2];
                    
                    if (pluginPath) {
                        await this.runFullTest(pluginPath, configFile);
                    } else {
                        console.log('Usage: test <plugin-path> [config-file]');
                    }
                } else if (command.startsWith('validate ')) {
                    const pluginPath = command.split(' ')[1];
                    if (pluginPath) {
                        await this.validatePluginStructure(pluginPath);
                    } else {
                        console.log('Usage: validate <plugin-path>');
                    }
                } else if (command === 'toggle-syntax-check') {
                    this.enableSyntaxTesting = !this.enableSyntaxTesting;
                    console.log(`Syntax checking: ${this.enableSyntaxTesting ? 'ON' : 'OFF'}`);
                } else if (command === 'toggle-echo-stdin') {
                    this.echoStdin = !this.echoStdin;
                    console.log(`Stdin echoing: ${this.echoStdin ? 'ON' : 'OFF'}`);
                } else if (command === 'list-env') {
                    console.log('Environment variables:');
                    Object.keys(process.env)
                        .filter(key => key.startsWith('JOB_') || key.startsWith('CRONICLE_'))
                        .forEach(key => console.log(`  ${key}=${process.env[key]}`));
                } else if (command.startsWith('set-timeout ')) {
                    const timeout = parseInt(command.split(' ')[1]);
                    if (timeout > 0) {
                        this.timeout = timeout;
                        console.log(`Timeout set to ${timeout}ms`);
                    } else {
                        console.log('Invalid timeout value');
                    }
                } else if (command === 'toggle-verbose') {
                    this.verbose = !this.verbose;
                    console.log(`Verbose mode: ${this.verbose ? 'ON' : 'OFF'}`);
                } else if (command.trim()) {
                    console.log('Unknown command. Type "help" for available commands.');
                }
            }
        } finally {
            rl.close();
        }
    }

    // Main test runner
    async runFullTest(pluginPath, configPath = null) {
        let testConfig = { testCases: [] };
        
        if (configPath) {
            const config = this.loadTestConfig(configPath);
            if (config) {
                testConfig = config;
            }
        }

        // Run validation
        const validationResults = await this.validatePluginStructure(pluginPath);
        
        // Run execution tests
        const executionResults = await this.testPluginExecution(pluginPath, testConfig.testCases);
        
        // Generate and print report
        const report = this.generateReport(pluginPath, validationResults, executionResults);
        this.printReport(report);
        
        return report;
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);
    const tester = new CroniclePluginTester();
    
    if (args.includes('--verbose') || args.includes('-v')) {
        tester.verbose = true;
    }
    
    if (args.includes('--syntax-check') || args.includes('-s')) {
        tester.enableSyntaxTesting = true;
    }
    
    if (args.includes('--echo-stdin') || args.includes('-e')) {
        tester.echoStdin = true;
    }
    
    if (args.includes('--timeout')) {
        const timeoutIndex = args.indexOf('--timeout');
        const timeoutValue = parseInt(args[timeoutIndex + 1]);
        if (timeoutValue > 0) {
            tester.timeout = timeoutValue;
        }
    }

    if (args.includes('--interactive') || args.includes('-i')) {
        await tester.interactiveMode();
        return;
    }

    if (args.length < 1) {
        console.log(`
🧪 Cronicle Plugin Test Harness

Usage:
  ${process.argv[1]} <plugin-path> [config-file] [options]
  ${process.argv[1]} --interactive [options]

Options:
  --verbose, -v          Enable verbose logging
  --syntax-check, -s     Enable JavaScript syntax validation (default: off)
  --echo-stdin, -e       Echo JSON parameters sent to plugin stdin
  --timeout <ms>         Set execution timeout (default: 30000)
  --interactive, -i      Enter interactive mode
  --help, -h             Show this help

Examples:
  ${process.argv[1]} /opt/cronicle/plugins/my-plugin.js
  ${process.argv[1]} ./plugin.js test-config.json --verbose --syntax-check
  ${process.argv[1]} ./plugin.js --echo-stdin --verbose
  ${process.argv[1]} --interactive

Plugin Specification:
  This harness follows the Cronicle plugin specification where:
  - Parameters are passed as JSON on stdin
  - Environment variables (JOB_ID, JOB_TITLE, etc.) are set
  - Plugins should read JSON from stdin and parse params/job info

Test Config Format (JSON):
{
  "testCases": [
    {
      "name": "test-name",
      "params": { "arg1": "value1" },
      "jobOverrides": { "title": "Custom Job Title" },
      "args": ["--flag"],
      "description": "Test description"
    }
  ]
}

JSON Payload Format (sent to plugin stdin):
{
  "params": { "parameter": "value" },
  "job": { "id": "job_id", "title": "Job Title", "username": "user" }
}

Note: JavaScript syntax checking is disabled by default for faster execution.
      Use --syntax-check to enable detailed syntax validation.
`);
        process.exit(1);
    }

    const pluginPath = args[0];
    const configPath = args[1];
    
    try {
        const report = await tester.runFullTest(pluginPath, configPath);
        
        // Exit with error code if tests failed
        if (!report.summary.validationPassed || report.summary.failedTests > 0) {
            process.exit(1);
        }
    } catch (err) {
        console.error('❌ Test execution failed:', err.message);
        process.exit(1);
    }
}

// Export for use as module
module.exports = CroniclePluginTester;

// Run as CLI if called directly
if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}