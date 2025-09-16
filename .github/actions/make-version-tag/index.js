const core = require("@actions/core");
const exec = require("@actions/exec");
const github = require("@actions/github");

async function getGitHash() {
  const { stdout: cliHash } = await exec.getExecOutput(
    "git",
    ["rev-parse", "--short=8", "HEAD"],
    {
      silent: true,
    }
  );
  return cliHash.trim();
}

function isEmpty(str) {
  return !str || str.trim().length === 0;
}

function rightPad(str, length = 2, padChar = "0") {
  str = String(str); // Ensure input is a string
  if (str.length >= length) return str;
  return str + padChar.repeat(length - str.length);
}

function leftPad(str, length = 2, padChar = "0") {
  str = String(str); // Ensure input is a string
  if (str.length >= length) return str;
  return padChar.repeat(length - str.length) + str;
}

function makeSafeName(name, replacement = "_") {
  if (!name) throw new Error("Name must not be null");
  let safe = name
    .replace(/[^a-zA-Z0-9]+/g, replacement)
    .split(replacement)
    .filter((x) => x.length > 0)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .join(replacement);

  //while (safe.startsWith(replacement)) safe = safe.slice(1);
  //while (safe.endsWith(replacement)) safe = safe.slice(0, -1);
  return safe;
}

async function run() {
  try {
    const projectName = core.getInput("projectName");
    const hashTag = core.getInput("hash");
    const extraName = core.getInput("extraName") ?? "";

    const safeJobName = makeSafeName(projectName);
    const hash = isEmpty(hashTag) ? await getGitHash() : hashTag.slice(0, 8);
    const dt = new Date();

    const runNumber = process.env.GITHUB_RUN_NUMBER ?? 0;
    console.log(`Current GitHub Actions run number: ${runNumber}`);

    /*
    const datePart = [
      dt.getFullYear(),
      leftPad(dt.getMonth() + 1),
      leftPad(dt.getDate()),
      leftPad(runNumber, 4),
    ].join(".");
    */

    const datePart = [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()].join(
      "."
    );

    const version = [datePart, runNumber, hash.trim(), extraName]
      .filter((v) => !isEmpty(v))
      .join("-");

    // Set outputs and environment variables
    core.exportVariable("SAFENAME", safeJobName);
    core.setOutput("safeName", safeJobName);
    core.exportVariable("VERSION", version);
    core.setOutput("version", version);
    console.log(`safeName: ${safeJobName} version: ${version}`);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
