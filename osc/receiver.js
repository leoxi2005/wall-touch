// Minimal OSC receiver over UDP (no dependencies).
// Parses OSC messages and #bundle packets; supports i/f/s/d argument types.

const dgram = require('dgram');

let sockets = [];

function readPaddedString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('ascii', off, end);
  // Strings are padded with NULs to a 4-byte boundary (at least one NUL).
  const next = (end + 4) & ~3;
  return [str, next];
}

function parseMessage(buf, off) {
  let address, tags;
  [address, off] = readPaddedString(buf, off);
  if (off >= buf.length || buf[off] !== 0x2c /* ',' */) {
    return { address, args: [] };
  }
  [tags, off] = readPaddedString(buf, off);
  const args = [];
  for (const t of tags.slice(1)) {
    switch (t) {
      case 'i': args.push(buf.readInt32BE(off)); off += 4; break;
      case 'f': args.push(buf.readFloatBE(off)); off += 4; break;
      case 'd': args.push(buf.readDoubleBE(off)); off += 8; break;
      case 's': case 'S': {
        let s; [s, off] = readPaddedString(buf, off); args.push(s); break;
      }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      default: return { address, args }; // unknown tag — stop parsing safely
    }
  }
  return { address, args };
}

function parsePacket(buf, cb) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    let off = 16; // '#bundle\0' + 8-byte timetag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off); off += 4;
      if (size <= 0 || off + size > buf.length) break;
      parsePacket(buf.subarray(off, off + size), cb);
      off += size;
    }
  } else {
    try {
      cb(parseMessage(buf, 0));
    } catch (err) {
      console.warn('[osc] parse error:', err.message);
    }
  }
}

// ports: number[]; onMessage receives { port, address, args }
function start(ports, onMessage) {
  stop();
  for (const port of ports) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (buf) =>
      parsePacket(buf, (msg) => onMessage({ port, ...msg }))
    );
    socket.on('error', (err) => console.error(`[osc:${port}] socket error:`, err.message));
    socket.bind(port, () => {
      console.log(`[osc] listening on udp://0.0.0.0:${port}`);
    });
    sockets.push(socket);
  }
}

function stop() {
  for (const s of sockets) {
    try { s.close(); } catch (_) {}
  }
  sockets = [];
}

module.exports = { start, stop };
