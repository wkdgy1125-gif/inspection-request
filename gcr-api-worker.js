// 검측요청서 작성기 - 팀 공유 서버 (Cloudflare Worker)
// ─────────────────────────────────────────────────────────
// 설정 방법 (Cloudflare 대시보드, 약 5분)
//  1) Storage & Databases → D1 → Create → 이름: inspection-request
//  2) Workers & Pages → Create → Worker → 이름: gcr-api → Deploy
//     → Edit code → 이 파일 내용 전체를 붙여넣기 → Deploy
//  3) gcr-api → Settings → Bindings → Add → D1 database
//     → Variable name: DB  /  Database: inspection-request → Save
//  표는 첫 접속 때 자동으로 만들어집니다.
//  비밀번호 없음: 웹페이지 주소를 아는 사람은 누구나 보고 편집할 수 있습니다.
// ─────────────────────────────────────────────────────────
const DEFAULT_PASS = '1234';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,x-pass',
  'access-control-max-age': '86400'
};
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
const enc = new TextEncoder();
const sha = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t)))].map(x => x.toString(16).padStart(2, '0')).join('');
const PATH_RE = /^(app\/common|reqs\/[A-Za-z0-9_\-.~:@+]{1,180})$/;
let ready = false;

async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, at TEXT, by TEXT, uid TEXT, no TEXT, json TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS imgs (id TEXT PRIMARY KEY, mime TEXT, data BLOB, at TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
  ]);
  ready = true;
}
async function authed(req, db) {
  let pw = '';
  try { pw = decodeURIComponent(req.headers.get('x-pass') || ''); } catch (e) { }
  if (!pw) return false;
  const row = await db.prepare('SELECT v FROM meta WHERE k = ?').bind('passHash').first();
  return (await sha(pw)) === (row ? row.v : await sha(DEFAULT_PASS));
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url), p = url.pathname, m = req.method;
    if (!env.DB) return new Response('D1 연결이 필요합니다: Settings → Bindings → D1 database → 변수 이름 DB', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    const db = env.DB;
    try {
      await init(db);
      if (p === '/api/ping') return json({ ok: true, app: 'gcr' });

      // 사진·도면·서명 이미지: 추측 불가능한 32자리 id로만 열람 (img 태그에서 바로 쓰도록 비밀번호 없이)
      const im = p.match(/^\/api\/img\/([a-f0-9]{32})$/);
      if (im && m === 'GET') {
        const r = await db.prepare('SELECT mime, data FROM imgs WHERE id = ?').bind(im[1]).first();
        if (!r) return new Response('not found', { status: 404, headers: CORS });
        const bytes = r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : ArrayBuffer.isView(r.data) ? r.data : new Uint8Array(r.data || []);
        return new Response(bytes, { headers: { 'content-type': r.mime || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', ...CORS } });
      }

      if (!p.startsWith('/api/')) return new Response('Not found', { status: 404, headers: CORS });

      if (p === '/api/check') return json({ ok: true });


      if (p === '/api/doc') {
        const path = url.searchParams.get('path') || '';
        if (!PATH_RE.test(path)) return json({ error: 'bad_path' }, 400);
        if (m === 'GET') {
          const r = await db.prepare('SELECT at, by, uid, no, json FROM docs WHERE path = ?').bind(path).first();
          return json(r ? { exists: true, ...r } : { exists: false });
        }
        if (m === 'PUT') {
          const b = await req.json().catch(() => null);
          if (!b || typeof b.json !== 'string') return json({ error: 'bad_body' }, 400);
          if (b.json.length > 1900000) return json({ error: 'too_large' }, 413);
          const at = new Date().toISOString();
          await db.prepare('INSERT OR REPLACE INTO docs (path, at, by, uid, no, json) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(path, at, String(b.by || '').slice(0, 64), String(b.uid || '').slice(0, 64), String(b.no || '').slice(0, 100), b.json).run();
          return json({ ok: true, at });
        }
      }

      // 변경 확인용: 여러 문서의 수정 시각만 가볍게 조회
      if (p === '/api/at' && m === 'GET') {
        const paths = url.searchParams.getAll('p').filter(x => PATH_RE.test(x)).slice(0, 10);
        const out = {};
        for (const x of paths) { const r = await db.prepare('SELECT at FROM docs WHERE path = ?').bind(x).first(); out[x] = r ? r.at : null; }
        return json(out);
      }

      if (p === '/api/img' && m === 'POST') {
        const mime = (req.headers.get('content-type') || 'image/jpeg').split(';')[0].slice(0, 40);
        if (!/^image\//.test(mime)) return json({ error: 'not_image' }, 400);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > 1900000) return json({ error: 'too_large' }, 413);
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
        await db.prepare('INSERT INTO imgs (id, mime, data, at) VALUES (?, ?, ?, ?)').bind(id, mime, buf, new Date().toISOString()).run();
        return json({ ok: true, id });
      }

      if (p === '/api/list' && m === 'GET') {
        const r = await db.prepare("SELECT path, at, no FROM docs WHERE path LIKE 'reqs/%' ORDER BY at DESC LIMIT 500").all();
        return json({ items: r.results || [] });
      }

      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'server', message: String(e && e.message || e) }, 500);
    }
  }
};
