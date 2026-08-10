// OSC → tracked touch points.
//
// The LiDAR Bridge in fusion mode (preset "Very Final - door-portals.json":
// format "slots", normalize true, 30 Hz) sends one bundle per wall:
//
//   /tuongN/count      i   how many people are touching wall N
//   /tuongN/pI/on      i   1
//   /tuongN/pI/x       f   0..1 ALONG the wall (0 = left edge)
//   /tuongN/pI/y       f   0..1 height, 0 = ceiling, 1 = floor  (bridge convention)
//   /tuongN/pI/v       f   speed, m/s (magnitude only — no direction)
//   /tuongN/pI/id      i   stable track id
//
// TWO THINGS WILL BITE ANYONE WHO SKIPS THEM:
//
// 1. `pI` is a SLOT index, not an identity. The bridge packs only the active tracks,
//    so when person A lifts their hand person B silently slides from p1 into p0. Bind
//    a stroke to the slot and it teleports across the room. Identity is `/pI/id`, and
//    `id` is the LAST field of the slot in the bundle — which is exactly why a slot is
//    committed on receiving `id`, never before.
//
// 2. `/pI/v` is a scalar. An ink swirl needs a DIRECTION, so velocity is differentiated
//    here from successive positions (30 Hz is plenty) and the bridge's `v` is kept only
//    as a sanity/HUD value.

export class TouchTracker {
  constructor(walls, oscCfg) {
    this.walls = walls;                       // [{ u0, uw }] in panorama uv
    this.pointRe = new RegExp(oscCfg.pointRule ?? '^/tuong(\\d+)/p(\\d+)/(on|x|y|v|id)$');
    this.countRe = new RegExp(oscCfg.countRule ?? '^/tuong(\\d+)/count$');
    this.flipY = oscCfg.flipY !== false;
    this.timeout = oscCfg.trackTimeout ?? 0.5;

    this.pending = walls.map(() => new Map());   // wall → slot → partial point
    this.counts = walls.map(() => 0);
    this.tracks = new Map();                     // "wall:id" → track
    this.now = 0;
    this.lastAddress = '—';
    this.packets = 0;
  }

  // Feed every OSC message here; anything that is not a point/count is ignored, so the
  // zone traffic Door Portals uses can keep flowing on the same port harmlessly.
  handle(msg) {
    const addr = msg.address || '';

    const mc = addr.match(this.countRe);
    if (mc) {
      const w = parseInt(mc[1], 10) - 1;
      if (w >= 0 && w < this.walls.length) this.counts[w] = Number(msg.args?.[0] ?? 0);
      this.packets++;
      this.lastAddress = `${addr} ${msg.args?.[0] ?? ''}`;
      return;
    }

    const m = addr.match(this.pointRe);
    if (!m) return;
    const w = parseInt(m[1], 10) - 1;
    const slot = parseInt(m[2], 10);
    const field = m[3];
    if (w < 0 || w >= this.walls.length) return;

    const map = this.pending[w];
    let p = map.get(slot);
    if (!p) { p = {}; map.set(slot, p); }
    p[field] = Number(msg.args?.[0] ?? 0);

    this.packets++;
    this.lastAddress = addr;

    // `id` closes the slot — every other field for this point has already arrived.
    if (field === 'id') {
      this._commit(w, p);
      map.delete(slot);
    }
  }

  _commit(wallIdx, p) {
    if (p.x == null || p.y == null || !Number.isFinite(p.id)) return;
    const wall = this.walls[wallIdx];
    const raw = Math.min(1, Math.max(0, p.x));
    const rawYin = Math.min(1, Math.max(0, p.y));
    const rawY = this.flipY ? 1 - rawYin : rawYin;   // → 0 = floor, 1 = ceiling

    // PER-WALL CORRECTION. The bridge's u,v is only as good as its warp quad, and that
    // quad's left/right edges were eyeballed — the laser fan overshoots the room corners,
    // so the baseline never sees where a wall actually ends.
    //
    // A quad is a PERSPECTIVE map, so its errors mix the axes: the horizontal error
    // depends on how high the hand is. A scale+offset on x alone therefore cannot remove
    // it — calibrate at one height and it comes back at another. uAffine is the 2D fit
    // (6 numbers, from 4 held points) that does; uScale/uOffset stay as the older 1D
    // fallback so an existing calibration keeps working.
    let fx, fy;
    const A = wall.uAffine;
    if (A && A.length === 6) {
      fx = A[0] + A[1] * raw + A[2] * rawY;
      fy = A[3] + A[4] * raw + A[5] * rawY;
    } else {
      fx = (raw - (wall.uOffset ?? 0)) * (wall.uScale ?? 1);
      fy = rawY;
    }
    fx = Math.min(1.2, Math.max(-0.2, fx));
    fy = Math.min(1.2, Math.max(-0.2, fy));

    const x = wall.u0 + fx * wall.uw;            // panorama uv, wraps at 1
    const y = fy;
    const key = `${wallIdx}:${p.id}`;

    let t = this.tracks.get(key);
    if (!t) {
      t = {
        key, wall: wallIdx, id: p.id, raw, rawY,
        x, y, vx: 0, vy: 0, speed: 0,
        born: this.now, lastSeen: this.now, fresh: true, moved: 0
      };
      this.tracks.set(key, t);
      return;
    }

    const dt = Math.max(1e-3, this.now - t.lastSeen);
    let dx = x - t.x;
    dx -= Math.round(dx);                        // pentagon wraps: take the short way
    const dy = y - t.y;

    // Half-and-half smoothing: raw 30 Hz deltas are jittery enough to make the ink
    // twitch, and anything heavier makes a fast swipe lag behind the hand.
    t.vx = t.vx * 0.5 + (dx / dt) * 0.5;
    t.vy = t.vy * 0.5 + (dy / dt) * 0.5;
    t.moved += Math.hypot(dx, dy);
    t.x = x; t.y = y; t.raw = raw; t.rawY = rawY;
    t.speed = p.v ?? 0;
    t.lastSeen = this.now;
    t.fresh = false;
  }

  // Drops tracks the bridge has stopped reporting. Deliberately time-based rather than
  // keyed off `/count`: a dropped UDP packet must not kill a live stroke.
  update(dt) {
    this.now += dt;
    for (const [key, t] of this.tracks) {
      if (this.now - t.lastSeen > this.timeout) this.tracks.delete(key);
    }
    return this.tracks;
  }

  get active() { return this.tracks.size; }
}
