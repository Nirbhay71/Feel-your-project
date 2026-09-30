// Who is really on the other end of a request to the agent route.
//
// `next dev` listens on every network interface (0.0.0.0), unlike Vite, so
// anyone on the same Wi-Fi can reach it. The Host header doesn't tell them
// apart — a client writes whatever Host it likes, and X-Forwarded-For too.
// Only the TCP connection itself can't be faked: its remote address.
//
// A route handler never sees the socket, only a Request. So withFeel has
// every request to this process's HTTP servers handled inside an
// AsyncLocalStorage that holds its socket's addresses; AsyncLocalStorage
// follows the request through all of Next's awaits into the route handler.
//
// The store lives on globalThis: next.config (which calls withFeel) and the
// agent route are loaded by different module systems, and may well get two
// copies of this file — they must still share one store.

import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';

const KEY = Symbol.for('@feel-dev/next.peer');

function state() {
  return (globalThis[KEY] ??= { als: new AsyncLocalStorage(), patched: false });
}

// Record the socket of every incoming request, from now on. Servers created
// before this call are covered too: emit is looked up on the prototype.
export function trackPeers() {
  const s = state();
  if (s.patched) return;
  s.patched = true;
  for (const Server of [http.Server, https.Server]) {
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, ...rest) {
      if (event !== 'request' || !req?.socket) return emit.call(this, event, req, ...rest);
      return s.als.run(peerOf(req.socket), () => emit.call(this, event, req, ...rest));
    };
  }
}

function peerOf(socket) {
  return {
    address: socket.remoteAddress, // the client
    localAddress: socket.localAddress, // this server, as the client reached it
    localPort: socket.localPort,
    secure: !!socket.encrypted,
  };
}

// The peer of the request being handled now, or null when it isn't known
// (withFeel didn't run in this process).
export function currentPeer() {
  return globalThis[KEY]?.als.getStore() ?? null;
}

// For tests: run fn as if a request from `peer` were being handled.
export function runAsPeer(peer, fn) {
  return state().als.run(peer, fn);
}

// 127.0.0.0/8, ::1, and IPv4 loopback seen through an IPv6 socket.
export function isLoopback(address) {
  if (!address) return false;
  const v4 = address.replace(/^::ffff:/i, '');
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4) || address === '::1';
}

// allowed: extra client addresses you let in ("192.168.1.20").
export function peerAllowed(peer, allowed = []) {
  if (!peer?.address) return false;
  if (isLoopback(peer.address)) return true;
  const plain = (a) => String(a).replace(/^::ffff:/i, '').toLowerCase();
  return [].concat(allowed ?? []).some((a) => plain(a) === plain(peer.address));
}

// This dev server, addressed the way the request reached it — never the
// Host header, which the client chose. Maps are fetched from here.
export function ownOrigin(peer) {
  const host = peer.localAddress.replace(/^::ffff:/i, '');
  return `${peer.secure ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${peer.localPort}`;
}
