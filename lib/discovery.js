// lib/discovery.js
// Drop-in replacement for Cronicle's UDP discovery using AWS IoT Core (MQTT)
// Requires: npm i aws-iot-device-sdk
//
// Config keys used (top-level unless noted):
//   aws_iot: {
//     endpoint: "xxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com",
//     client_id_prefix: "cronicle",
//     ca_path: "/opt/cronicle/conf/AmazonRootCA1.pem",
//     cert_path: "/opt/cronicle/conf/device-cert.pem",
//     key_path: "/opt/cronicle/conf/device-key.pem",
//     port: 8883,                 // optional, default 8883
//     topic_prefix: "cronicle/discovery", // optional, default "cronicle/discovery"
//     qos: 0                      // optional
//   },
//   cluster_id: "default",        // optional; used to namespace topics
//   discovery_broadcast_freq: 5000 // optional; ms between heartbeats (default 5000)
//
// Behavior:
// - Publishes presence heartbeat JSON on:  <topic_prefix>/<cluster_id>/presence/<hostname>
// - Subscribes to:                         <topic_prefix>/<cluster_id>/presence/+
// - Maintains in-memory map of nearby servers with lastSeen timestamps
// - Exposes getNearbyServers() for UI/API parity with original discovery
//
// References:
// - Cronicle UDP broadcast setting (original feature): docs/Configuration.md (udp_broadcast_port)
// - AWS IoT MQTT topics and SDK: see README links below

'use strict';

const os = require('os');
const crypto = require('crypto');

const Class = require('pixl-class');
const Component = require('pixl-server/component');

// Prefer v1 SDK for simple MTLS device cert flow
let awsIot;
try {
  awsIot = require('aws-iot-device-sdk');
}
catch (e) {
  // allow startup to continue; we'll log a helpful error later
}

module.exports = Class.create({
  __name: 'Discovery',     // component name (matches Cronicle pattern)
  __parent: Component,

  discoveryTick: function() {
    this._prune();
  },                                                                   
                                                                                                  
  setupDiscovery: function(callback) {                                                            
      this.nearby = {};              // hostname -> { host, ip, port, lastSeen, payload }
      this.heartbeatTimer = null;
      this.pruneTimer = null;

      // derive identifiers
      this.hostname = this.server.hostname || os.hostname();
      this.pid = process.pid;
      this.nodeId = `${this.hostname}:${this.pid}`;

      // config
      this.clusterId = this.server.config.get('cluster_id') || 'default';
      this.freq = parseInt(this.server.config.get('discovery_broadcast_freq') || 5000, 10);

      const netPort = this.server.config.get('web_socket_port') || this.server.config.get('web_port') || 3012;
      this.listenPort = netPort;

      const awsCfg = this.server.config.get('aws_iot') || {};
      this.awsCfg = Object.assign({
        port: 8883,
        qos: 0,
        topic_prefix: 'cronicle/discovery',
        endpoint: 'iot.us-east-2.amazonaws.com',
        ca_path: "/opt/cronicle/conf/AmazonRootCA1.pem",
        cert_path: "/opt/cronicle/conf/device-cert.pem",
        key_path: "/opt/cronicle/conf/private-key.pem"
      }, awsCfg);

      if (!awsIot) {
        this.logError('discovery', "Missing dependency aws-iot-device-sdk. Run: npm i aws-iot-device-sdk");
        // still call back so Cronicle starts; discovery will be inert
        return callback && callback();
      }
      if (!awsCfg.endpoint || !awsCfg.cert_path || !awsCfg.key_path || !awsCfg.ca_path) {
        this.logError('discovery', "AWS IoT config incomplete (need endpoint, ca_path, cert_path, key_path). Discovery disabled.");
        return callback && callback();
      }

      // Build clientId (stable-ish but unique per process)
      const cidPrefix = awsCfg.client_id_prefix || 'cronicle';
      const rand = crypto.randomBytes(3).toString('hex');
      this.clientId = `${cidPrefix}-${this.hostname}-${this.pid}-${rand}`;

      // topic scheme
      this.topicBase = `${this.awsCfg.topic_prefix}/${this.clusterId}`;
      this.topicPresence = `${this.topicBase}/presence/${this.hostname}`;
      this.topicPresenceSub = `${this.topicBase}/presence/+`;

      // create device (MTLS)
      this.device = awsIot.device({
        host: this.awsCfg.endpoint,
        port: this.awsCfg.port,
        protocol: 'mqtts',
        clientId: this.clientId,
        caPath: this.awsCfg.ca_path,
        certPath: this.awsCfg.cert_path,
        keyPath: this.awsCfg.key_path,
        reconnectPeriod: 3000,          // ms
        keepalive: 30                   // seconds
      });

      this._bindDeviceEvents();

      // proceed with startup; connection events will drive heartbeats
      this.logDebug(3, `AWS IoT discovery init: clientId=${this.clientId}, cluster=${this.clusterId}, topic=${this.topicPresence}`);
      callback && callback();
  },

  shutdownDiscovery: function (callback) {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.pruneTimer);

    if (this.device) {
      try {
        // aws-iot-device-sdk v1: end([force])
        this.device.end(true, () => {
          this.device = null;
          this.logDebug(3, "AWS IoT discovery shut down");
          callback && callback();
        });
      } catch (e) {
        // be resilient
        this.device = null;
        callback && callback();
      }
    } else {
      callback && callback();
    }
  },

  // ----- helpers -----

  _bindDeviceEvents() {
    this.device.on('connect', () => {
      this.logDebug(4, "AWS IoT connected; subscribing to presence");
      this.device.subscribe(this.topicPresenceSub, { qos: this.awsCfg.qos }, (err) => {
        if (err) this.logError('discovery', `Subscribe error: ${err.message || err}`);
      });

      // start periodic heartbeat
      this._sendHeartbeat();
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), this.freq);

      // prune stale peers every 10 * freq (or min 30s)
      clearInterval(this.pruneTimer);
      const pruneEvery = Math.max(30000, this.freq * 10);
      this.pruneTimer = setInterval(() => this._prune(), pruneEvery);
    });

    this.device.on('reconnect', () => {
      this.logDebug(5, "AWS IoT reconnecting…");
    });

    this.device.on('close', () => {
      this.logDebug(5, "AWS IoT connection closed");
    });

    this.device.on('error', (err) => {
      this.logError('discovery', `AWS IoT error: ${err && err.message ? err.message : err}`);
    });

    this.device.on('message', (topic, payload) => {
      try {
        if (!topic.startsWith(`${this.topicBase}/presence/`)) return;
        const raw = payload ? payload.toString('utf8') : '';
        const msg = JSON.parse(raw);

        // ignore our own messages
        if (msg.hostname === this.hostname && msg.pid === this.pid) return;

        const host = msg.hostname || 'unknown';
        // Normalize record (compatible fields for UI)
        const now = Date.now();
        this.nearby[host] = {
          host,
          ip: msg.ip || msg.address || '',
          port: msg.port || this.listenPort,
          lastSeen: now,
          payload: msg
        };

        this.logDebug(9, `Discovery: heard ${host}`, this.nearby[host]);
      }
      catch (e) {
        this.logError('discovery', `Failed to parse discovery message on ${topic}: ${e.message}`);
      }
    });
  },

  _sendHeartbeat() {
    if (!this.device) return;
    const ips = this._getIPv4Addrs();
    const body = {
      op: 'hello',
      ts: Date.now(),
      hostname: this.hostname,
      pid: this.pid,
      port: this.listenPort,
      // preserve some naming from UDP original for parity
      address: ips.length ? ips[0] : '',
      ip: ips.length ? ips[0] : '',
      addrs: ips,
      // meta for debug
      clientId: this.clientId,
      cluster: this.clusterId
    };
    try {
      this.device.publish(this.topicPresence, JSON.stringify(body), { qos: this.awsCfg.qos });
      this.logDebug(9, `Discovery heartbeat published to ${this.topicPresence}`);
    }
    catch (e) {
      this.logError('discovery', `Publish error: ${e.message}`);
    }
  },

  _prune() {
    // Remove peers not seen for ~3 * freq (min 20s)
    const now = Date.now();
    const ttl = Math.max(20000, this.freq * 3);
    Object.keys(this.nearby).forEach((host) => {
      if (now - (this.nearby[host].lastSeen || 0) > ttl) delete this.nearby[host];
    });
  },

  _getIPv4Addrs() {
    const out = [];
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach((name) => {
      (ifaces[name] || []).forEach((iface) => {
        if (iface && iface.family === 'IPv4' && !iface.internal) {
          out.push(iface.address);
        }
      });
    });
    return out;
  },

  // ----- public / parity helpers -----

  // Matches what the UI/API wants: a compact array
  getNearbyServers() {
    // [{ host, ip, port, lastSeen, payload }]
    return Object.values(this.nearby).sort((a, b) => b.lastSeen - a.lastSeen);
  },

  // Kept for parity with older code paths that may reference this.
  getStats() {
    return {
      nearby: this.getNearbyServers(),
      topic: this.topicPresence,
      subscribed: this.topicPresenceSub,
      clientId: this.clientId || null,
      connected: !!this.device
    };
  }
});
