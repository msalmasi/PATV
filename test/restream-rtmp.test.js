// Offline tests for the relay worker's own RTMP publisher (deploy/restream/patv-restream.js, 1.99go): a fake RTMP
// server on loopback checks the handshake, connect/createStream/publish with the stream name ONLY in the publish
// commands, @setDataFrame metadata, chunked big messages, extended timestamps, ping answers, and refusals.
//   node --test test/restream-rtmp.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const path = require("path");
const W = require(path.resolve(__dirname, "..", "deploy", "restream", "patv-restream.js"));

const KEY = "live_123456789_SecretSecretSecret";

function flvTag(type, ts, body) {
  const h = Buffer.alloc(11);
  h[0] = type; h.writeUIntBE(body.length, 1, 3);
  h.writeUIntBE(ts & 0xffffff, 4, 3); h[7] = (ts >>> 24) & 0xff;
  const t = Buffer.alloc(4); t.writeUInt32BE(11 + body.length, 0);
  return Buffer.concat([h, body, t]);
}
const FLV_HEAD = Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);

/** A tiny RTMP server: plain handshake, answers connect/createStream/publish (publishCode decides the onStatus). */
function fakeServer(o = {}) {
  const seen = { commands: [], media: [], pong: null, closed: false, raw: [] };
  const server = net.createServer((sock) => {
    let hs = Buffer.alloc(0), shaken = false;
    const send = (csid, type, msid, payload) => sock.write(W.chunkMessage(csid, type, msid, 0, payload, 4096));
    const cmd = (...vals) => send(3, 20, 0, Buffer.concat(vals.map(W.amfEnc)));
    const reader = new W.ChunkReader((m) => {
      if (m.type === 1) { reader.chunkSize = m.payload.readUInt32BE(0); return; }
      if (m.type === 4 && m.payload.readUInt16BE(0) === 7) { seen.pong = m.payload.readUInt32BE(2); return; }
      if (m.type === 20) {
        const a = W.amfDecAll(m.payload);
        seen.commands.push({ msid: m.msid, a });
        if (a[0] === "connect") {
          const w = Buffer.alloc(4); w.writeUInt32BE(5000000, 0); send(2, 5, 0, w);
          const pb = Buffer.alloc(5); pb.writeUInt32BE(5000000, 0); pb[4] = 2; send(2, 6, 0, pb);
          const ping = Buffer.alloc(6); ping.writeUInt16BE(6, 0); ping.writeUInt32BE(424242, 2); send(2, 4, 0, ping);
          cmd("_result", a[1], { fmsVer: "FMS/3,0,1,123" }, { level: "status", code: "NetConnection.Connect.Success" });
        } else if (a[0] === "createStream") {
          cmd("_result", a[1], null, 7);
        } else if (a[0] === "publish") {
          const code = o.publishCode || "NetStream.Publish.Start";
          send(5, 20, 7, Buffer.concat(["onStatus", 0, null, { level: /Start/.test(code) ? "status" : "error", code, description: a[3] + " says the server" }].map(W.amfEnc)));
        }
        return;
      }
      if (![8, 9, 18].includes(m.type)) return;   // ack / window size etc.
      seen.media.push({ type: m.type, ts: m.ts, msid: m.msid, payload: m.payload });
      if (o.onMedia) o.onMedia(seen);
    });
    sock.on("data", (d) => {
      seen.raw.push(d);
      if (shaken) return reader.push(d);
      hs = Buffer.concat([hs, d]);
      if (hs.length >= 1537 && !sock.s1) {
        sock.s1 = true;
        const s1 = Buffer.alloc(1536, 7);
        // a server chunk size change before anything else (exercises the reader)
        sock.write(Buffer.concat([Buffer.from([3]), s1, hs.subarray(1, 1537)]));
      }
      if (hs.length >= 3073) {
        shaken = true;
        const cs = Buffer.alloc(4); cs.writeUInt32BE(4096, 0); send(2, 1, 0, cs);
        if (hs.length > 3073) reader.push(hs.subarray(3073));
      }
    });
    sock.on("close", () => { seen.closed = true; });
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ server, seen, port: server.address().port })));
}
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

test("publishes: handshake, connect (app + tcUrl, no key), publish(key), metadata, big + extended-timestamp media, pong, clean end", async () => {
  const { server, seen, port } = await fakeServer();
  const pub = new W.RtmpPublisher(`rtmp://127.0.0.1:${port}/app/${KEY}`);
  const errors = [];
  pub.on("error", (e) => errors.push(e));
  await new Promise((r) => pub.once("ready", r));
  const meta = Buffer.concat([W.amfEnc("onMetaData"), W.amfEnc({ width: 1920, height: 1080 })]);
  const big = Buffer.alloc(10000); for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const flv = Buffer.concat([FLV_HEAD, flvTag(18, 0, meta), flvTag(9, 40, big), flvTag(8, 0x1000005, Buffer.from([0xaf, 1, 2, 3]))]);
  // fed in awkward pieces (split tags)
  for (let i = 0; i < flv.length; i += 777) pub.write(flv.subarray(i, i + 777));
  await waitFor(() => seen.media.length >= 3 && seen.pong !== null);
  const names = seen.commands.map((c) => c.a[0]);
  assert.deepEqual(names.slice(0, 5), ["connect", "releaseStream", "FCPublish", "createStream", "publish"]);
  const connect = seen.commands[0].a[2];
  assert.equal(connect.app, "app");
  assert.equal(connect.tcUrl, `rtmp://127.0.0.1:${port}/app`);
  assert.ok(!JSON.stringify(connect).includes(KEY), "the key is not in connect");
  const publish = seen.commands[4];
  assert.equal(publish.a[3], KEY); assert.equal(publish.a[4], "live"); assert.equal(publish.msid, 7);
  const [m0, m1, m2] = seen.media;
  assert.equal(m0.type, 18); assert.deepEqual(W.amfDecAll(m0.payload).slice(0, 2), ["@setDataFrame", "onMetaData"]);
  assert.equal(m1.type, 9); assert.equal(m1.ts, 40); assert.ok(m1.payload.equals(big), "10 kB video reassembled across chunks");
  assert.equal(m2.type, 8); assert.equal(m2.ts, 0x1000005, "extended timestamp"); assert.equal(m2.msid, 7);
  assert.equal(seen.pong, 424242, "ping answered");
  pub.end();
  await waitFor(() => seen.closed);
  assert.ok(seen.commands.some((c) => c.a[0] === "FCUnpublish"));
  assert.ok(seen.commands.some((c) => c.a[0] === "deleteStream"));
  assert.deepEqual(errors, []);
  server.close();
});

test("a refused publish is an error (and the publisher closes)", async () => {
  const { server, port } = await fakeServer({ publishCode: "NetStream.Publish.BadName" });
  const pub = new W.RtmpPublisher(`rtmp://127.0.0.1:${port}/app/${KEY}`);
  const e = await new Promise((r) => pub.once("error", r));
  assert.match(e.message, /publish refused: NetStream\.Publish\.BadName/);
  assert.equal(pub.state, "closed");
  server.close();
});

test("server gone: connection refused / closed mid-stream are errors; a silent server times out", async () => {
  const { server, port } = await fakeServer();
  server.close();
  await new Promise((r) => setTimeout(r, 20));
  const p1 = new W.RtmpPublisher(`rtmp://127.0.0.1:${port}/app/${KEY}`);
  const e1 = await new Promise((r) => p1.once("error", r));
  assert.match(e1.message, /connection: ECONNREFUSED/);
  assert.ok(!e1.message.includes(KEY));

  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const p2 = new W.RtmpPublisher(`rtmp://127.0.0.1:${silent.address().port}/app/${KEY}`, { setupMs: 200 });
  const e2 = await new Promise((r) => p2.once("error", r));
  assert.match(e2.message, /no publish within/);
  p2.destroy(); silent.close();

  const s3 = await fakeServer({ onMedia: () => {} });
  const p3 = new W.RtmpPublisher(`rtmp://127.0.0.1:${s3.port}/app/${KEY}`);
  await new Promise((r) => p3.once("ready", r));
  const closed = new Promise((r) => p3.once("error", r));
  p3.sock.destroy(new Error("reset"));           // the connection drops mid-stream
  const e3 = await closed;
  assert.match(e3.message, /connection: reset/);
  s3.server.close();
});

test("target parsing: app + name, rtmps default port, bad targets throw", () => {
  const p = new W.RtmpPublisher("rtmps://lhr03.contribute.live-video.net/app/" + KEY + "?bandwidthtest=true", { connect: () => Object.assign(new (require("events").EventEmitter)(), { destroy() {} }) });
  assert.equal(p.app, "app"); assert.equal(p.name, KEY + "?bandwidthtest=true"); assert.equal(p.port, 443); assert.equal(p.secure, true);
  assert.equal(p.tcUrl, "rtmps://lhr03.contribute.live-video.net/app");
  p.destroy();
  assert.throws(() => new W.RtmpPublisher("rtmp://host/onlyapp"), /app and a stream name/);
  assert.throws(() => new W.RtmpPublisher("http://host/app/x"), /not an rtmp/);
});
