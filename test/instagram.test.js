import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(28)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrx-i-'));
const app = createApp({ dbPath: ':memory:', authLimit: 1000, uploadDir: dir });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${app.server.address().port}`;
const H = { 'X-Requested-With': 'scrxaper' };
const call = async (method, url, body, cookie) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...H, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const join = async (n) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: n, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
const up = async (kind, bytes, cookie, extra = '') => { const r = await fetch(`${base}/api/upload?kind=${kind}${extra}`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: bytes }); return { status: r.status, data: await r.json() }; };
const get = (id, cookie, headers = {}) => fetch(`${base}/files/${id}`, { headers: { Cookie: cookie, ...headers } });

test('custom sounds must be real audio, are private to their owner, and can be chosen as tone or ringtone', async () => {
  const [a, b] = [await join('tamsin'), await join('ulf')];
  assert.equal((await up('sound', Buffer.from('this is definitely not audio at all'), a)).status, 400);
  assert.equal((await up('sound', Buffer.concat([WAV, Buffer.alloc(500 * 1024)]), a)).status, 413);
  const sound = (await up('sound', WAV, a, '&name=My%20bell!.wav')).data.id;
  assert.deepEqual((await call('GET', '/api/sounds', null, a)).data, [{ id: sound, label: 'My bell.wav' }]);
  assert.equal((await get(sound, a)).headers.get('content-type'), 'audio/wav');
  assert.equal((await get(sound, b)).status, 404);
  assert.equal((await call('POST', '/api/sound', { tone: `custom:${sound}`, ringtone: 'pulse', volume: 70 }, b)).status, 400);
  const saved = await call('POST', '/api/sound', { tone: 'soft', ringtone: `custom:${sound}`, volume: 70 }, a);
  assert.equal(saved.data.ringtone, `custom:${sound}`);
  await call('POST', '/api/sound/override', { kind: 'ring', target: 'ulf', tone: `custom:${sound}` }, a);
  assert.equal((await call('POST', '/api/sound/override', { kind: 'ring', target: 'ulf', tone: 'custom:' + 'f'.repeat(32) }, a)).status, 400);
  const after = await call('POST', '/api/sounds/delete', { id: sound }, a);
  assert.equal(after.data.ringtone, 'ring');
  assert.equal(after.data.overrides.length, 0);
  assert.equal((await get(sound, a)).status, 404);
});

test('following, profile counts and the feed', async () => {
  const [a, b, c] = [await join('vera'), await join('wes2'), await join('xena')];
  assert.equal((await call('POST', '/api/follow', { username: 'vera', follow: true }, a)).status, 400);
  const pb = (await up('post', PNG, b)).data.id; const pc = (await up('post', PNG, c)).data.id;
  await call('POST', '/api/posts', { media: pb, caption: 'from wes' }, b);
  await call('POST', '/api/posts', { media: pc, caption: 'from xena' }, c);
  assert.equal((await call('GET', '/api/feed', null, a)).data.length, 0);
  assert.equal((await call('POST', '/api/follow', { username: 'wes2', follow: true }, a)).data.followers, 1);
  const feed = (await call('GET', '/api/feed', null, a)).data;
  assert.deepEqual(feed.map((p) => p.caption), ['from wes']);
  const profile = (await call('GET', '/api/profile?user=wes2', null, a)).data;
  assert.deepEqual([profile.posts, profile.followers, profile.following, profile.isFollowing], [1, 1, 0, true]);
  assert.equal((await call('GET', '/api/profile?user=vera', null, b)).data.followsYou, true);
  await call('POST', '/api/follow', { username: 'wes2', follow: false }, a);
  assert.equal((await call('GET', '/api/feed', null, a)).data.length, 0);
});

test('posts: only the owner can edit or delete, media cannot be reused, likes and comments follow the rules', async () => {
  const [a, b] = [await join('yara'), await join('zane')];
  const m = (await up('post', PNG, a)).data.id;
  assert.equal((await get(m, b)).status, 404);
  assert.equal((await call('POST', '/api/posts', { media: m, caption: 'stolen' }, b)).status, 400);
  const id = (await call('POST', '/api/posts', { media: m, caption: 'sunset' }, a)).data.id;
  assert.equal((await call('POST', '/api/posts', { media: m }, a)).status, 409);
  assert.equal((await get(m, b)).status, 200);
  assert.equal((await call('POST', '/api/posts/edit', { post: id, caption: 'hijack' }, b)).status, 404);
  await call('POST', '/api/posts/edit', { post: id, caption: 'sunset, edited' }, a);
  assert.equal((await call('POST', '/api/posts/like', { post: id, liked: true }, b)).data.likes, 1);
  await call('POST', '/api/posts/like', { post: id, liked: true }, b);
  assert.equal((await call('GET', `/api/post?id=${id}`, null, b)).data.likes, 1);
  assert.equal((await call('POST', '/api/posts/comment', { post: id, body: '' }, b)).status, 400);
  const cid = (await call('POST', '/api/posts/comment', { post: id, body: 'lovely' }, b)).data.id;
  const detail = (await call('GET', `/api/post?id=${id}`, null, a)).data;
  assert.deepEqual([detail.caption, detail.editedAt > 0, detail.comments[0].body, detail.liked], ['sunset, edited', true, 'lovely', false]);
  assert.equal((await call('POST', '/api/posts/comment-delete', { comment: cid }, await join('nosy')) ).status, 404);
  assert.equal((await call('POST', '/api/posts/comment-delete', { comment: cid }, a)).status, 200);
  await call('POST', '/api/block', { username: 'zane', blocked: true }, a);
  assert.equal((await call('GET', `/api/post?id=${id}`, null, b)).status, 404);
  assert.equal((await call('POST', '/api/posts/like', { post: id, liked: true }, b)).status, 404);
  assert.equal((await get(m, b)).status, 404);
  assert.equal((await call('POST', '/api/posts/delete', { post: id }, b)).status, 404);
  assert.equal((await call('POST', '/api/posts/delete', { post: id }, a)).status, 200);
  assert.equal((await get(m, a)).status, 404);
});

test('reels accept real video only, appear in the reels list, and support range requests', async () => {
  const [a, b] = [await join('arlo'), await join('bree')];
  assert.equal((await up('reel', Buffer.from('not a video, just some long enough text'), a)).status, 400);
  const v = (await up('reel', WEBM, a)).data.id;
  const id = (await call('POST', '/api/posts', { media: v, caption: 'first reel' }, a)).data.id;
  assert.equal((await call('GET', '/api/reels', null, b)).data[0].id, id);
  assert.equal((await call('GET', '/api/reels', null, b)).data[0].kind, 'reel');
  const full = await get(v, b);
  assert.equal(full.headers.get('content-type'), 'video/webm');
  const part = await get(v, b, { Range: 'bytes=0-9' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-9/${WEBM.length}`);
  assert.equal((await get(v, b, { Range: 'bytes=9999-' })).status, 416);
});

test('stories last 24 hours, show to followers and the owner, track views, and are removed when expired', async () => {
  const [a, b, c] = [await join('cato'), await join('dara'), await join('elio')];
  const m = (await up('story', PNG, a)).data.id;
  const sid = (await call('POST', '/api/stories', { media: m }, a)).data.id;
  assert.equal((await call('POST', '/api/stories', { media: m }, a)).status, 409);
  assert.equal((await call('GET', '/api/stories', null, b)).data.length, 0);
  await call('POST', '/api/follow', { username: 'cato', follow: true }, b);
  const tray = (await call('GET', '/api/stories', null, b)).data;
  assert.equal(tray[0].username, 'cato'); assert.equal(tray[0].allSeen, false);
  assert.equal((await get(m, b)).status, 200);
  await call('POST', '/api/stories/view', { story: sid }, b);
  assert.equal((await call('GET', '/api/stories', null, b)).data[0].allSeen, true);
  assert.deepEqual((await call('GET', `/api/stories/viewers?story=${sid}`, null, a)).data.map((v) => v.username), ['dara']);
  assert.equal((await call('GET', `/api/stories/viewers?story=${sid}`, null, c)).status, 404);
  assert.equal((await call('POST', '/api/stories/delete', { story: sid }, c)).status, 404);
  app.db.prepare('UPDATE stories SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, sid);
  assert.equal((await get(m, b)).status, 404);
  assert.equal(app.sweepStories(), 1);
  assert.equal((await get(m, a)).status, 404);
  assert.equal((await call('GET', '/api/stories', null, a)).data.length, 0);
});
