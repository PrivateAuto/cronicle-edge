#!/usr/bin/env node

/**
 * Cronicle "mongosh" plugin
 * - Reads one JSON job descriptor line from STDIN (Cronicle contract)
 * - Executes mongosh with either an inline script, a file path, or --eval
 * - Streams stdout/stderr to the Cronicle job log
 * - Emits a single JSON line with { complete: 1, code: <exitCode>, description? }
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");

function readJobJSON() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => {
      // Cronicle compacts job JSON to one line terminating in \n
      const line = buf.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
      if (!line) return reject(new Error("No job JSON found on stdin"));
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.resume();
  });
}

function println(obj) {
  // IMPORTANT: Cronicle interprets single-line JSON on stdout.
  // Only emit JSON when you *mean* it (e.g., final completion line).
  process.stdout.write(JSON.stringify(obj) + "\n");
}

(async () => {
  let job;
  try {
    job = await readJobJSON();
  } catch (err) {
    println({
      complete: 1,
      code: 1,
      description: `Failed to parse job JSON: ${err.message}`,
    });
    process.exit(0);
    return;
  }

  const p = job.params || {}; // plugin params (also exposed as env vars by Cronicle)
  // Always use 'mongosh' from system PATH
  const mongoshPath = "mongosh";
  let mongoUri = "";
  try {
    // Determine environment and role to assume
    const environment = p.environment || "padev";
    const roleMap = {
      padev: "arn:aws:iam::182399724557:role/pa-octopus-oidc-role",
      privateauto: "arn:aws:iam::331322215907:role/pa-octopus-oidc-role",
    };
    const roleArn = roleMap[environment];
    if (!roleArn) {
      println({
        complete: 1,
        code: 20,
        description: `No role configured for environment: ${environment}`,
      });
      process.exit(0);
      return;
    }

    // Assume the role using AWS CLI
    let creds = null;
    try {
      const output = execSync(
        `aws sts assume-role --role-arn "${roleArn}" --role-session-name mongosh-plugin-session`,
        { encoding: "utf8" }
      );
      creds = JSON.parse(output).Credentials;
      if (!creds) throw new Error("No credentials in assume-role output");
      process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
      process.env.AWS_SESSION_TOKEN = creds.SessionToken;
    } catch (e) {
      println({
        complete: 1,
        code: 21,
        description: `Failed to assume role for environment ${environment}: ${e.message}`,
      });
      process.exit(0);
      return;
    }

    // Will throw if AWS CLI or creds are not present
    mongoUri = execSync(
      'aws ssm get-parameter --name /pa/mongo/uri --with-decryption --query "Parameter.Value" --output text',
      { encoding: "utf8" }
    ).trim();
    if (!mongoUri) throw new Error("Empty URI from SSM");
  } catch (e) {
    println({
      complete: 1,
      code: 11,
      description: `Failed to fetch mongo URI from SSM: ${e.message}`,
    });
    process.exit(0);
    return;
  }

  // Only support inline script mode
  const inlineScript = p.inline_script || "";
  const extraArgs = (p.extra_args || "").trim();

  const args = [mongoUri];
  if (p.quiet) args.push("--quiet");
  if (extraArgs) {
    const toks = Array.from(
      extraArgs.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)
    ).map((m) => m[1] || m[2] || m[3]);
    args.push(...toks);
  }

  let tmpFile = null;
  try {
    let scriptBody = inlineScript || "";
    tmpFile =
      fs.mkdtempSync(path.join(os.tmpdir(), "cronicle-mongosh-")) + ".js";
    fs.writeFileSync(tmpFile, scriptBody, "utf8");
    args.push("--file", tmpFile);

    // Spawn mongosh
    const child = spawn(mongoshPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env, // Cronicle already uppercases params as env vars
    });

    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));

    child.on("error", (err) => {
      println({
        complete: 1,
        code: 5,
        description: `Failed to spawn mongosh: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (typeof code === "number" && code === 0) {
        println({ complete: 1, code: 0 });
      } else {
        println({
          complete: 1,
          code: code || 1,
          description: `mongosh exited with code ${code}`,
        });
      }
      if (tmpFile) {
        try {
          fs.unlinkSync(tmpFile);
        } catch {}
      }
    });
  } catch (err) {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
    println({
      complete: 1,
      code: 6,
      description: `Unhandled error: ${err.message}`,
    });
  }
})();
