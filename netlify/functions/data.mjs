import { getStore } from '@netlify/blobs';

export default async (req) => {
  const store = getStore('inventory');

  // GET: read the saved data (includes the stored version stamp)
  if (req.method === 'GET') {
    try {
      const data = await store.get('state', { type: 'json' });
      const out = data || { items: {}, state: {}, version: 0 };
      if (out.version == null) out.version = 0;
      return new Response(JSON.stringify(out), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ items: {}, state: {}, version: 0 }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
  }

  // POST: save the current data. The server owns the version counter — it reads the current
  // stored version and writes back version+1, so every successful save is strictly newer than
  // the last. The new version is returned so the client can track what it just wrote.
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      let current = null;
      try { current = await store.get('state', { type: 'json' }); } catch (e) { current = null; }
      const prevVersion = (current && typeof current.version === 'number') ? current.version : 0;
      const newVersion = prevVersion + 1;
      const toSave = { items: body.items || {}, state: body.state || {}, version: newVersion };
      await store.setJSON('state', toSave);
      return new Response(JSON.stringify({ ok: true, version: newVersion }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/api/data' };
