// Body check-in photos (checkins.js): stored as <date>_<pose>.jpg per profile, private to it,
// JPEG only, and untouched by the media sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const U1 = 'u_chk_1', U2 = 'u_chk_2';
const cookie = uid => ({ Cookie: `gymsid=${mint(uid)}`, Origin: ORIGIN });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200)]);

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-chk-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: U1, name: 'Ana', created: new Date().toISOString() }, { id: U2, name: 'Bo', created: new Date().toISOString() }],
    creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost' }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => log);
  const url = p => `http://127.0.0.1:${port}${p}`;
  return {
    dataDir,
    put: (d, pose, body, uid = U1) => fetch(url(`/api/checkins/${d}/${pose}`), { method: 'PUT', headers: { ...cookie(uid), 'Content-Type': 'image/jpeg' }, body }),
    get: (d, pose, uid = U1) => fetch(url(`/api/checkins/${d}/${pose}`), { headers: cookie(uid) }),
    del: (d, pose, uid = U1) => fetch(url(`/api/checkins/${d}/${pose}`), { method: 'DELETE', headers: cookie(uid) }),
    list: (uid = U1) => fetch(url('/api/checkins'), { headers: cookie(uid) }).then(r => r.json()),
    anon: p => fetch(url(p))
  };
}

test('a photo is stored as <date>_<pose>.jpg and read back byte for byte', async t => {
  const h = await start(t);
  assert.equal((await h.put('2026-10-10', 'front', JPEG)).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(h.dataDir, 'progress', U1, '2026-10-10_front.jpg')), JPEG);
  const r = await h.get('2026-10-10', 'front');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
});

test('the list groups poses by day, newest first, and a re-take overwrites', async t => {
  const h = await start(t);
  await h.put('2026-10-03', 'side', JPEG);
  await h.put('2026-10-10', 'back', JPEG);
  await h.put('2026-10-10', 'front', JPEG);
  const other = Buffer.concat([JPEG, Buffer.from('x')]);
  await h.put('2026-10-10', 'front', other);
  assert.deepEqual((await h.list()).days, [{ d: '2026-10-10', poses: ['front', 'back'] }, { d: '2026-10-03', poses: ['side'] }]);
  assert.deepEqual(Buffer.from(await (await h.get('2026-10-10', 'front')).arrayBuffer()), other);
});

test('only JPEGs, only real dates, only known poses', async t => {
  const h = await start(t);
  assert.equal((await h.put('2026-10-10', 'front', Buffer.from('\x89PNG\r\n\x1a\n'))).status, 415);
  assert.equal((await h.put('2026-13-45', 'front', JPEG)).status, 400);
  assert.equal((await h.put('2026-10-10', 'top', JPEG)).status, 404);
  assert.equal((await h.put('..%2F..%2Fdb', 'front', JPEG)).status, 404);
  assert.deepEqual((await h.list()).days, []);
});

test('photos are private to their profile and need a session', async t => {
  const h = await start(t);
  await h.put('2026-10-10', 'front', JPEG);
  assert.equal((await h.get('2026-10-10', 'front', U2)).status, 404);
  assert.deepEqual((await h.list(U2)).days, []);
  assert.equal((await h.anon('/api/checkins')).status, 401);
  assert.equal((await h.anon('/api/checkins/2026-10-10/front')).status, 401);
});

test('delete removes the file', async t => {
  const h = await start(t);
  await h.put('2026-10-10', 'side', JPEG);
  assert.equal((await h.del('2026-10-10', 'side')).status, 200);
  assert.equal((await h.get('2026-10-10', 'side')).status, 404);
  assert.deepEqual((await h.list()).days, []);
});
