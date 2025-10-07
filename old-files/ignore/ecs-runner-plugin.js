#!/usr/bin/env node
/**
 * Cronicle "AWS ECS Runner" plugin
 * - Starts an ECS task (FARGATE/EC2) from an existing task definition or a one-off image-based TD
 * - Optional live CloudWatch Logs streaming (with include/exclude regex)
 * - Optional post-run log fetch
 * - Final single-line JSON: { complete:1, code:<exit>, description?, details? }
 */

const {
    ECSClient,
    RunTaskCommand,
    DescribeTasksCommand,
    RegisterTaskDefinitionCommand,
    DeregisterTaskDefinitionCommand
  } = require('@aws-sdk/client-ecs');
  const {
    CloudWatchLogsClient,
    GetLogEventsCommand,
    DescribeLogStreamsCommand
  } = require('@aws-sdk/client-cloudwatch-logs');
  
  const { setTimeout: sleep } = require('timers/promises');
  
  function readJobJSON() {
    return new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => (buf += d));
      process.stdin.on('end', () => {
        const line = buf.split(/\r?\n/).find(l => l.trim().startsWith('{'));
        if (!line) return reject(new Error('No job JSON found on stdin'));
        try { resolve(JSON.parse(line)); }
        catch (e) { reject(e); }
      });
      process.stdin.resume();
    });
  }
  
  function println(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
  
  (async () => {
    let job;
    try { job = await readJobJSON(); }
    catch (err) {
      println({ complete: 1, code: 1, description: `Failed to parse job JSON: ${err.message}` });
      return;
    }
  
    const p = job.params || {};
  
    // Region/creds
    const region = p.aws_region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const credentials = (p.aws_access_key_id && p.aws_secret_access_key) ? {
      accessKeyId: p.aws_access_key_id,
      secretAccessKey: p.aws_secret_access_key,
      sessionToken: p.aws_session_token || undefined
    } : undefined;
  
    const ecs = new ECSClient({ region, credentials });
    const logs = new CloudWatchLogsClient({ region, credentials });
  
    // Core ECS params
    const cluster = p.ecs_cluster || '';
    const launchType = (p.launch_type || 'FARGATE').toUpperCase();
    const mode = (p.mode || 'task_definition'); // "task_definition" | "image"
  
    // Networking
    const subnets = (p.subnets || '').split(',').map(s => s.trim()).filter(Boolean);
    const securityGroups = (p.security_groups || '').split(',').map(s => s.trim()).filter(Boolean);
    const assignPublicIp = (String(p.assign_public_ip || 'DISABLED').toUpperCase() === 'ENABLED') ? 'ENABLED' : 'DISABLED';
  
    // Log options (post-run)
    const tailLogs = !!p.tail_logs;
    const logGroup = p.cw_log_group || '';
    const logPrefix = p.cw_log_stream_prefix || 'ecs';
    const logFetchLimit = Number(p.log_fetch_limit || 1000);
  
    // LIVE streaming options
    const streamLogsLive = !!p.stream_logs_live;
    const streamFromHead = !!p.stream_log_start_from_head;
    const streamPollSec = Number(p.stream_log_poll_interval_sec || 3);
  
    // Regex filters
    let includeRegex = null, excludeRegex = null;
    try { if (p.log_include_regex) includeRegex = new RegExp(p.log_include_regex); }
    catch (e) { process.stderr.write(`Invalid include regex: ${e.message}\n`); }
    try { if (p.log_exclude_regex) excludeRegex = new RegExp(p.log_exclude_regex); }
    catch (e) { process.stderr.write(`Invalid exclude regex: ${e.message}\n`); }
    function shouldPrintLogLine(line) {
      if (includeRegex && !includeRegex.test(line)) return false;
      if (excludeRegex && excludeRegex.test(line)) return false;
      return true;
    }
  
    // Wait config
    const waitTimeoutSec = Number(p.wait_timeout_sec || 1800);
    const waitPollSec = Number(p.wait_poll_interval_sec || 5);
  
    // TD / image options
    const platformVersion = p.platform_version || undefined;
    const propagateTags = p.propagate_tags || undefined;
    const taskDefinition = p.task_definition || '';
    const family = p.family || 'cronicle-ecs-runner';
    const containerName = p.container_name || 'app';
    const image = p.image || '';
    const cpu = p.cpu ? String(p.cpu) : undefined;
    const memory = p.memory ? String(p.memory) : undefined;
    const taskRoleArn = p.task_role_arn || undefined;
    const executionRoleArn = p.execution_role_arn || undefined;
  
    const command = (p.command || '').trim()
      ? (Array.isArray(p.command) ? p.command : ('' + p.command).split(' ').filter(Boolean))
      : undefined;
  
    const envPairs = (p.environment || '').split(',').map(s => s.trim()).filter(Boolean);
    const environment = envPairs.map(kv => {
      const i = kv.indexOf('=');
      if (i < 0) return null;
      return { name: kv.slice(0, i), value: kv.slice(i + 1) };
    }).filter(Boolean);
  
    const secretPairs = (p.secrets || '').split(',').map(s => s.trim()).filter(Boolean);
    const secrets = secretPairs.map(kv => {
      const i = kv.indexOf('=');
      if (i < 0) return null;
      return { name: kv.slice(0, i), valueFrom: kv.slice(i + 1) };
    }).filter(Boolean);
  
    const requiresCompatibilities = (p.requires_compatibilities || launchType).toUpperCase();
  
    if (!cluster) {
      println({ complete: 1, code: 2, description: 'Missing ecs_cluster parameter' });
      return;
    }
    if (mode === 'task_definition' && !taskDefinition) {
      println({ complete: 1, code: 3, description: 'mode=task_definition but task_definition is empty' });
      return;
    }
    if (mode === 'image' && !image) {
      println({ complete: 1, code: 4, description: 'mode=image but image is empty' });
      return;
    }
  
    async function streamCwLogsUntilStopped({ logsClient, logGroup, logPrefix, container, taskArn, pollSec, startFromHead, isRunningRef }) {
      if (!logGroup) return;
      try {
        const taskId = (taskArn || '').split('/').pop();
        const streamName = `${logPrefix}/${container}/${taskId}`;
  
        let nextToken = undefined;
        let streamFound = false;
  
        while (isRunningRef()) {
          try {
            if (!streamFound) {
              const { logStreams } = await logsClient.send(new DescribeLogStreamsCommand({
                logGroupName: logGroup,
                logStreamNamePrefix: `${logPrefix}/${container}/${taskId}`,
                orderBy: 'LastEventTime',
                descending: true,
                limit: 1
              }));
              streamFound = !!(logStreams && logStreams.length);
              if (!streamFound) {
                await sleep(pollSec * 1000);
                continue;
              }
            }
  
            const out = await logsClient.send(new GetLogEventsCommand({
              logGroupName: logGroup,
              logStreamName: streamName,
              nextToken,
              startFromHead: !!startFromHead,
              limit: 10000
            }));
  
            if (out.events && out.events.length) {
              for (const e of out.events) {
                if (e.message != null && shouldPrintLogLine(e.message)) {
                  process.stdout.write(e.message + '\n');
                }
              }
            }
  
            if (out.nextForwardToken && out.nextForwardToken !== nextToken) {
              nextToken = out.nextForwardToken;
            }
  
            await sleep(pollSec * 1000);
          } catch (e) {
            process.stderr.write(`(live log tail error: ${e.message})\n`);
            await sleep(Math.max(pollSec, 3) * 1000);
          }
        }
  
        // One last sweep after STOPPED
        try {
          const out = await logsClient.send(new GetLogEventsCommand({
            logGroupName: logGroup,
            logStreamName: streamName,
            nextToken,
            startFromHead: false,
            limit: 10000
          }));
          if (out.events && out.events.length) {
            for (const e of out.events) {
              if (e.message != null && shouldPrintLogLine(e.message)) {
                process.stdout.write(e.message + '\n');
              }
            }
          }
        } catch {}
      } catch (outer) {
        process.stderr.write(`(live log tail setup failed: ${outer.message})\n`);
      }
    }
  
    // Optionally register one-off TD (image mode)
    let registeredTaskDefArn = null;
    try {
      if (mode === 'image') {
        const containerDef = {
          name: containerName,
          image,
          essential: true,
          command,
          environment: environment.length ? environment : undefined,
          secrets: secrets.length ? secrets : undefined,
          logConfiguration: logGroup ? {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logGroup,
              'awslogs-region': region,
              'awslogs-stream-prefix': logPrefix
            }
          } : undefined
        };
  
        const reg = await ecs.send(new RegisterTaskDefinitionCommand({
          family,
          requiresCompatibilities: [ requiresCompatibilities ],
          networkMode: (requiresCompatibilities === 'FARGATE') ? 'awsvpc' : undefined,
          cpu,
          memory,
          taskRoleArn,
          executionRoleArn,
          containerDefinitions: [ containerDef ]
        }));
  
        registeredTaskDefArn = reg?.taskDefinition?.taskDefinitionArn || null;
      }
    } catch (err) {
      println({ complete: 1, code: 5, description: `Failed to register task definition: ${err.message}` });
      return;
    }
  
    const taskDefToRun = registeredTaskDefArn || taskDefinition;
  
    // Build RunTask
    const runReq = {
      cluster,
      taskDefinition: taskDefToRun,
      launchType,
      platformVersion,
      propagateTags,
      overrides: {
        containerOverrides: (command || environment.length)
          ? [{ name: containerName, command, environment: environment.length ? environment : undefined }]
          : undefined
      }
    };
  
    if (requiresCompatibilities === 'FARGATE') {
      if (!subnets.length) {
        println({ complete: 1, code: 6, description: 'FARGATE requires subnets (params.subnets)' });
        return;
      }
      runReq.networkConfiguration = {
        awsvpcConfiguration: {
          subnets,
          securityGroups: securityGroups.length ? securityGroups : undefined,
          assignPublicIp
        }
      };
    }
  
    // Run
    let taskArn;
    try {
      const run = await ecs.send(new RunTaskCommand(runReq));
      const failures = run.failures || [];
      if (failures.length) {
        println({ complete: 1, code: 7, description: `RunTask failures: ${failures.map(f => `${f.reason}:${f.arn||''}`).join(', ')}` });
        return;
      }
      taskArn = run.tasks?.[0]?.taskArn;
      if (!taskArn) {
        println({ complete: 1, code: 8, description: 'ECS returned no task ARN' });
        return;
      }
      process.stdout.write(`Started ECS task: ${taskArn}\n`);
    } catch (err) {
      println({ complete: 1, code: 9, description: `RunTask error: ${err.message}` });
      return;
    }
  
    // Live tail (optional)
    let running = true;
    const isRunningRef = () => running;
    let liveTailPromise = null;
    if (streamLogsLive && logGroup) {
      liveTailPromise = streamCwLogsUntilStopped({
        logsClient: logs,
        logGroup,
        logPrefix,
        container: containerName,
        taskArn,
        pollSec: streamPollSec,
        startFromHead: streamFromHead,
        isRunningRef
      });
    }
  
    // Wait for STOPPED
    const start = Date.now();
    let lastStatus = 'UNKNOWN';
    let stopCode = 1;
    let containerStatuses = [];
    try {
      while (true) {
        const desc = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
        const task = desc.tasks?.[0];
        if (!task) throw new Error('DescribeTasks returned no task');
        lastStatus = task.lastStatus;
  
        if (lastStatus === 'STOPPED') {
          containerStatuses = (task.containers || []).map(c => ({
            name: c.name,
            exitCode: (typeof c.exitCode === 'number' ? c.exitCode : null),
            reason: c.reason || ''
          }));
          stopCode = containerStatuses.every(c => c.exitCode === 0) ? 0 : 1;
          break;
        }
        if ((Date.now() - start) / 1000 > waitTimeoutSec) {
          stopCode = 124; // timeout
          break;
        }
        await sleep(waitPollSec * 1000);
      }
    } catch (err) {
      println({ complete: 1, code: 10, description: `Error while waiting for task to stop: ${err.message}` });
      running = false;
      if (liveTailPromise) { try { await liveTailPromise; } catch {} }
      return;
    }
  
    // Stop live tail and wait for it to finish
    running = false;
    if (liveTailPromise) { try { await liveTailPromise; } catch {} }
  
    // Post-run logs (optional)
    if (tailLogs && logGroup) {
      try {
        const taskId = taskArn.split('/').pop();
        const streamName = `${logPrefix}/${containerName}/${taskId}`;
        const dls = await logs.send(new DescribeLogStreamsCommand({
          logGroupName: logGroup,
          logStreamNamePrefix: `${logPrefix}/${containerName}/${taskId}`,
          orderBy: 'LastEventTime',
          descending: true,
          limit: 1
        }));
        if (dls.logStreams && dls.logStreams.length) {
          const gle = await logs.send(new GetLogEventsCommand({
            logGroupName: logGroup,
            logStreamName: streamName,
            startFromHead: true,
            limit: logFetchLimit
          }));
          for (const e of (gle.events || [])) {
            if (e.message != null && shouldPrintLogLine(e.message)) {
              process.stdout.write(e.message + '\n');
            }
          }
        } else {
          process.stdout.write(`(No log stream found: ${streamName})\n`);
        }
      } catch (err) {
        process.stderr.write(`CloudWatch logs fetch failed: ${err.message}\n`);
      }
    }
  
    // Cleanup one-off TD
    if (registeredTaskDefArn && !p.keep_task_definition) {
      try {
        await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: registeredTaskDefArn }));
        process.stdout.write(`Deregistered task definition: ${registeredTaskDefArn}\n`);
      } catch (err) {
        process.stderr.write(`Deregister TD failed: ${err.message}\n`);
      }
    }
  
    // Final JSON line
    if (stopCode === 0) {
      println({ complete: 1, code: 0, description: `ECS task stopped OK (${lastStatus})`, details: { taskArn, containers: containerStatuses } });
    } else {
      println({ complete: 1, code: stopCode, description: `ECS task stopped with non-zero exit`, details: { taskArn, containers: containerStatuses } });
    }
  })();
  