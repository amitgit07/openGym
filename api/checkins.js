/* Body check-in photos: one front, side and back photo per day, stored as plain files named by
 * date and pose so a progress video is one ffmpeg glob away:
 *
 *   DATA_DIR/progress/<uid>/2026-10-10_front.jpg
 *
 * Deliberately outside the media system (media.js): nothing in the synced state references these,
 * so its sweep never sees them, and nothing here is content-addressed. Re-taking a pose on the same
 * day overwrites the file. The client always sends a JPEG it has already resized (well under the
 * 5 MB nginx cap on /api/), so the server only checks the magic bytes and the size.
 */
import fs from 'node:fs';
import path from 'node:path';

export const POSES = ['front', 'side', 'back'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})_(front|side|back)\.jpg$/;
const MAX_BYTES = 4 * 1024 * 1024;

export const checkinPath = /^\/api\/checkins\/(\d{4}-\d{2}-\d{2})\/(front|side|back)$/;

export function checkinRoutes({ dir, json, readSession }) {
  const userDir = uid => path.join(dir, uid);
  const validDate = d => DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

  function readJpeg(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0; let over = false;
      req.on('data', d => {
        size += d.length;
        if (size > MAX_BYTES) { over = true; chunks.length = 0; return; }
        if (!over) chunks.push(d);
      });
      req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  return {
    // Every day with at least one photo, newest first: [{ d, poses: ['front', 'side'] }].
    'GET /api/checkins': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      let names = [];
      try { names = fs.readdirSync(userDir(user.id)); } catch { /* no photos yet */ }
      const days = new Map();
      for (const n of names) {
        const m = FILE_RE.exec(n);
        if (!m) continue;
        if (!days.has(m[1])) days.set(m[1], []);
        days.get(m[1]).push(m[2]);
      }
      const list = [...days].map(([d, poses]) => ({ d, poses: POSES.filter(p => poses.includes(p)) }))
        .sort((a, b) => (a.d < b.d ? 1 : -1));
      json(res, 200, { days: list });
    },
    'GET /api/checkins/{date}/{pose}': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const { date, pose } = req.checkin;
      const file = path.join(userDir(user.id), `${date}_${pose}.jpg`);
      let buf;
      try { buf = fs.readFileSync(file); } catch { return json(res, 404, { error: 'not found' }); }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(buf.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin'
      });
      res.end(buf);
    },
    'PUT /api/checkins/{date}/{pose}': async (req, res) => {
      const user = readSession(req);
      if (!user) { req.resume(); return json(res, 401, { error: 'not signed in' }); }
      const { date, pose } = req.checkin;
      if (!validDate(date)) { req.resume(); return json(res, 400, { error: 'bad date' }); }
      const buf = await readJpeg(req);
      if (!buf) return json(res, 413, { error: 'photo too large' });
      if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return json(res, 415, { error: 'not a JPEG' });
      fs.mkdirSync(userDir(user.id), { recursive: true });
      const file = path.join(userDir(user.id), `${date}_${pose}.jpg`);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      json(res, 200, { ok: true, d: date, pose });
    },
    'DELETE /api/checkins/{date}/{pose}': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const { date, pose } = req.checkin;
      try { fs.unlinkSync(path.join(userDir(user.id), `${date}_${pose}.jpg`)); } catch { /* already gone */ }
      json(res, 200, { ok: true });
    }
  };
}

export function removeCheckins(dir, uid) {
  fs.rmSync(path.join(dir, uid), { recursive: true, force: true });
}
