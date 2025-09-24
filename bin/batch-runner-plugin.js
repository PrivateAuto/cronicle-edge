#!/usr/bin/env node

// Suppress AWS SDK v2 deprecation warnings at the process level
process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = '1';
process.env.NODE_NO_WARNINGS = '1';

/**
 * Cronicle Plugin: Custom Batch Job Runner
 *
 * Parameters (set on the Event using this Plugin):
 *   - name (string): Job name; used to find the generic package in CodeArtifact.
 *   - version (string): Version; used to find the generic package in CodeArtifact.
 *   - environment (string enum): "padev" | "privateauto" — selects IAM role to assume.
 *   - script (string): Multiline bash script to execute inside the extracted code directory.
 *   - annotate (boolean): If true, annotates log lines with date.
 *
 * Behavior:
 *   - Uses existing AWS credentials from the execution environment for CodeArtifact access.
 *   - Assumes an IAM role based on the `environment` using an internal ROLE_MAP.
 *   - Downloads code from CodeArtifact as a generic package using {name}/{version}.
 *   - Extracts into a temp working directory.
 *   - Creates a temporary script file and executes it with bash (cwd = extraction root) with assumed-role AWS creds in env.
 *   - Streams stdout/stderr into Cronicle's job log and forwards progress updates (e.g., lines like "42%").
 *
 * Update the constants DOMAIN_NAME, REPOSITORY_NAME and ROLE_MAP to match your AWS account(s).
 *
 * Requires: pixl-json-stream, pixl-tools, @aws-sdk/client-sts, @aws-sdk/client-codeartifact, unzipper, node-fetch, tar
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const JSONStream = require('pixl-json-stream');
const Tools = require('pixl-tools');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { CodeartifactClient, GetAuthorizationTokenCommand, GetPackageVersionAssetCommand } = require('@aws-sdk/client-codeartifact');
const unzipper = require('unzipper');
const tar = require('tar');


// ====== EDIT THESE FOR YOUR ENVIRONMENT ======
const DOMAIN_NAME = process.env.CRONICLE_BATCH_DOMAIN || "privateauto";
const REPOSITORY_NAME = process.env.CRONICLE_BATCH_REPOSITORY || "privateauto";
// Repository is owned by assets account, but policy makes it available to entire organization
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "173305588364";
const DEFAULT_REGION = "us-east-2";
const ROLE_MAP = {
  padev: "arn:aws:iam::182399724557:role/pa-octopus-oidc-role",
  privateauto: "arn:aws:iam::331322215907:role/pa-octopus-oidc-role"
};
// If you want to customize the key structure, edit this function:
const packageKeyFor = (name, version) => `${name}/${version}`;
// ============================================

// Setup Cronicle JSON messaging over stdio
process.stdin.setEncoding('utf8');
process.stdout.setEncoding('utf8');
const stream = new JSONStream(process.stdin, process.stdout);

// Utility: append to Cronicle-managed log file
function logAppend(job, line) {
  try { fs.appendFileSync(job.log_file, (line.endsWith('\n') ? line : line + "\n")); }
  catch (e) { /* ignore logging errors */ }
}

// Utility: finalize job with error
function fail(job, message) {
  logAppend(job, `ERROR ${message}`);
  stream.write({ complete: 1, code: 1, description: message });
}

// Utility: cleanup working directory and script file
function cleanupWorkDir(workDir, scriptPath = null) {
  try {
    if (scriptPath && fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
  catch (e) { /* ignore cleanup errors */ }
}

// Utility: finalize job with error and cleanup
function failWithCleanup(job, message, workDir) {
  if (workDir) cleanupWorkDir(workDir);
  fail(job, message);
}

// Handle job JSON from Cronicle
stream.on('json', async (job) => {
  const params = job.params || {};
  const name = String(params.name || '').trim();
  const version = String(params.version || '').trim();
  const environment = String(params.environment || '').trim();
  const script = String(params.script || '');
  const annotate = Boolean(params.annotate);

  if (!name) return failWithCleanup(job, "Missing required parameter name", null);
  if (!version) return failWithCleanup(job, "Missing required parameter version", null);
  if (!environment) return failWithCleanup(job, "Missing required parameter environment", null);
  if (!script.trim()) return failWithCleanup(job, "Missing required parameter script", null);
  if (!DOMAIN_NAME || DOMAIN_NAME.startsWith("REPLACE_ME_")) return failWithCleanup(job, "DOMAIN_NAME is not configured. Set CRONICLE_BATCH_DOMAIN env var or edit plugin.", null);
  if (!REPOSITORY_NAME || REPOSITORY_NAME.startsWith("REPLACE_ME_")) return failWithCleanup(job, "REPOSITORY_NAME is not configured. Set CRONICLE_BATCH_REPOSITORY env var or edit plugin.", null);
  if (!ROLE_MAP[environment]) return failWithCleanup(job, `Invalid environment ${environment}`, null);

  const workDir = path.join(os.tmpdir(), `cronicle-batch-${job.id}`);
  const packagePath = path.join(workDir, `${name}-${version}`);
  const packageKey = packageKeyFor(name, version);

  try { fs.mkdirSync(workDir, { recursive: true }); }
  catch (e) { return failWithCleanup(job, `Unable to create working directory: ${e.message}`, workDir); }

  logAppend(job, `[Cronicle Batch] Starting job id=${job.id} name=${name} version=${version}`);
  logAppend(job, `[Cronicle Batch] Using CodeArtifact domain: ${DOMAIN_NAME}, repository: ${REPOSITORY_NAME}, package: ${packageKey}`);

  // Variables for package download and extraction
  let usedAssetName = null;

  // 1) Assume IAM role
  let assumedRole;
  try {
    const sts = new STSClient({
      region: process.env.AWS_REGION || DEFAULT_REGION
    });
    
    const resp = await sts.send(new AssumeRoleCommand({
      RoleArn: ROLE_MAP[environment],
      RoleSessionName: `cronicle-batch-${job.id}`
    }));
    if (!resp.Credentials) throw new Error("No credentials returned from STS");
    assumedRole = resp.Credentials;
    logAppend(job, `[Cronicle Batch] Assumed IAM role: ${ROLE_MAP[environment]}`);
  } catch (e) {
    return failWithCleanup(job, `AssumeRole failed: ${e.message}`, workDir);
  }


  // 2) Get authorization token for CodeArtifact
  try {
    const codeartifact = new CodeartifactClient({
      region: process.env.AWS_REGION || DEFAULT_REGION,
      credentials: {
        accessKeyId: assumedRole.AccessKeyId,
        secretAccessKey: assumedRole.SecretAccessKey,
        sessionToken: assumedRole.SessionToken
      },
      domain: DOMAIN_NAME,
      domainOwner: ACCOUNT_ID,
    });

    const resp = await codeartifact.send(new GetAuthorizationTokenCommand({
      region: process.env.AWS_REGION || DEFAULT_REGION,
      domain: DOMAIN_NAME,
      domainOwner: ACCOUNT_ID,
      durationSeconds: 0
    }));
    if (!resp.authorizationToken) throw new Error("No authorization token returned from CodeArtifact");
    logAppend(job, `[Cronicle Batch] Got authorization token for CodeArtifact.`);
  } catch (e) {
    return failWithCleanup(job, `GetAuthorizationToken failed!: ${e.message}`, workDir);
  }

  // 3) Download package from CodeArtifact
  try {
    const codeartifact = new CodeartifactClient({
      region: process.env.AWS_REGION || DEFAULT_REGION,
      credentials: {
        accessKeyId: assumedRole.AccessKeyId,
        secretAccessKey: assumedRole.SecretAccessKey,
        sessionToken: assumedRole.SessionToken
      }
    });
    
    // Try different asset name formats that might exist in CodeArtifact
    const possibleAssetNames = [
      `${name}-${version}.zip`,
      `${name}-v${version}.zip`,
      `${name}.zip`,
      `${name}-${version}.tgz`,
      `${name}-v${version}.tgz`,
      `${name}.tgz`,
      // Try without the git hash suffix (in case version has commit hash)
      `${name}-${version.split('-')[0]}.zip`,
      `${name}-v${version.split('-')[0]}.zip`,
      `${name}-${version.split('-')[0]}.tgz`,
      `${name}-v${version.split('-')[0]}.tgz`,
      // Generic fallbacks
      'package.zip',
      'package.tgz',
      'asset.zip',
      'asset.tgz',
      'source.zip',
      'source.tgz'
    ];
    
    let resp = null;
    let attemptedAssets = [];

    for (const assetName of possibleAssetNames) {
      try {
        logAppend(job, `[Cronicle Batch] Attempting to download asset: ${assetName}`);
        attemptedAssets.push(assetName);

        resp = await codeartifact.send(new GetPackageVersionAssetCommand({
          domain: DOMAIN_NAME,
          domainOwner: ACCOUNT_ID,
          repository: REPOSITORY_NAME,
          format: 'generic',
          namespace: 'job',
          package: name,
          packageVersion: version,
          asset: assetName
        }));
        usedAssetName = assetName;
        logAppend(job, `[Cronicle Batch] Successfully found asset: ${assetName}`);
        break;
      } catch (e) {
        if (e.name === 'ResourceNotFoundException') {
          logAppend(job, `[Cronicle Batch] Asset not found: ${assetName}`);
          continue; // Try next asset name
        }
        logAppend(job, `[Cronicle Batch] Error accessing asset ${assetName}: ${e.message}`);
        throw e; // Re-throw other errors
      }
    }

    if (!resp || !resp.asset) {
      throw new Error(`No asset found. Tried: ${attemptedAssets.join(', ')}`);
    }

    // Determine file extension based on the asset name
    const fileExtension = usedAssetName.endsWith('.zip') ? '.zip' : '.tgz';
    const packageFilePath = packagePath + fileExtension;

    // Download the package with better error handling
    await new Promise((resolve, reject) => {
      const packageFile = fs.createWriteStream(packageFilePath);

      packageFile.on('error', reject);
      packageFile.on('finish', () => {
        logAppend(job, `[Cronicle Batch] Downloaded package from CodeArtifact using asset: ${usedAssetName}`);
        resolve();
      });

      resp.asset.on('error', reject);
      resp.asset.pipe(packageFile);
    });
  } catch (e) {
    return failWithCleanup(job, `Failed to download package: ${e.message}`, workDir);
  }

  // 4) Extract package
  try {
    // Determine file extension and extract accordingly
    const fileExtension = usedAssetName.endsWith('.zip') ? '.zip' : '.tgz';
    const packageFilePath = packagePath + fileExtension;

    // Small delay to ensure file system operations are complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify file exists and has content
    const stats = fs.statSync(packageFilePath);
    if (stats.size === 0) {
      throw new Error(`Downloaded file is empty: ${packageFilePath}`);
    }
    logAppend(job, `[Cronicle Batch] Verifying package file: ${stats.size} bytes`);

    if (fileExtension === '.zip') {
      // Extract zip file with better error handling
      await new Promise((resolve, reject) => {
        fs.createReadStream(packageFilePath)
        .pipe(unzipper.Extract({ 
          path: workDir,
          preservePath: true // Preserve full directory paths from the zip file
        }))   
          .on('error', reject)
          .on('close', resolve)
          .on('finish', resolve);
      });
      logAppend(job, `[Cronicle Batch] Extracted ZIP package into ${workDir}`);
    } else {
      // Extract tar.gz file
      await tar.x({
        file: packageFilePath,
        cwd: workDir,
        strip: 0, // Don't strip any leading path components
        preservePaths: true // Preserve full directory paths
      });
      logAppend(job, `[Cronicle Batch] Extracted TAR package into ${workDir}`);
    }
  } catch (e) {
    return failWithCleanup(job, `Package extraction failed: ${e.message}`, workDir);
  }

  // 5) Create temporary script file and execute with bash in working dir
  const scriptPath = path.join(workDir, `cronicle-batch-script-${job.id}.sh`);

  try {
    // Create script file with proper bash header and the user's script
    const scriptContent = `#!/bin/bash
set -e  # Exit on error
set -u  # Exit on undefined variable
set -o pipefail  # Exit on pipe failure

# User's script begins here
${script}
`;

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    logAppend(job, `[Cronicle Batch] Created script file: ${path.basename(scriptPath)}`);
  } catch (e) {
    return failWithCleanup(job, `Failed to create script file: ${e.message}`, workDir);
  }

  const childEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: assumedRole.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: assumedRole.SecretAccessKey,
    AWS_SESSION_TOKEN: assumedRole.SessionToken
  };

  let killTimer = null;
  let stderrBuffer = "";
  let sentHtml = false;

  const child = cp.spawn('bash', [scriptPath], {
    cwd: workDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Child output handling (mirror shell-plugin behavior)
  const cstream = new JSONStream(child.stdout, child.stdin);
  cstream.recordRegExp = /^\s*\{.+\}\s*$/;

  cstream.on('json', (data) => {
    // Forward structured progress or html if child emits JSON
    stream.write(data);
    if (data && data.html) sentHtml = true;
  });

  cstream.on('text', (line) => {
    // Recognize "NN%" as progress updates, otherwise append to log
    const m = line.match(/^\s*(\d+)\%\s*$/);
    if (m) {
      const pct = Math.max(0, Math.min(100, parseInt(m[1], 10))) / 100;
      stream.write({ progress: pct });
    } else {
      if (annotate) {
        const dargs = Tools.getDateArgs(new Date());
        line = `[${dargs.yyyy_mm_dd} ${dargs.hh_mi_ss}] ${line}`;
      }
      logAppend(job, line);
    }
  });

  cstream.on('error', (err, text) => {
    const errorMsg = text || `Stream error: ${err.message || err}`;
    logAppend(job, errorMsg);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => {
    if (stderrBuffer.length < 32768) stderrBuffer += data;
    else if (!stderrBuffer.endsWith('...')) stderrBuffer += '...';
    logAppend(job, data);
  });

  child.on('error', (err) => {
    const errorDesc = Tools.getErrorDescription(err);
    logAppend(job, `Script error: ${errorDesc}`);
    stream.write({
      complete: 1,
      code: 1,
      description: "Script failed: " + errorDesc
    });
  });

  child.on('exit', async (code, signal) => {
    if (killTimer) clearTimeout(killTimer);
    code = (code || signal || 0);

    const data = {
      complete: 1,
      code: code,
      description: code ? ("Script exited with code: " + code) : ""
    };

    if (stderrBuffer.trim()) {
      if (!sentHtml) {
        data.html = { title: "Error Output", content: "<pre>" + stderrBuffer.replace(/</g, '&lt;').trim() + "</pre>" };
      }
      const first = stderrBuffer.trim().split(/\n/).shift();
      if (code && first && first.length < 256) data.description += (data.description ? ": " : "") + first;
    }

    stream.write(data);

    cleanupWorkDir(workDir, scriptPath);
  });

  // Pass job down to child (harmless for bash; helpful for other interpreters)
  try { cstream.write(job); child.stdin.end(); }
  catch (e) { /* ignore */ }

  // Graceful shutdown hook
  process.on('SIGTERM', () => {
    logAppend(job, `Caught SIGTERM, terminating child: ${child.pid}`);
    killTimer = setTimeout(() => {
      logAppend(job, `Child did not exit, sending SIGKILL: ${child.pid}`);
      try { child.kill('SIGKILL'); } catch (e) {}
    }, 9000);
    try { child.kill('SIGTERM'); } catch (e) {}
  });
});
