import { getStore } from '@netlify/blobs';

export default async (req) => {
  const store = getStore('inventory');
  const url = new URL(req.url);

  // ---- Restore-point snapshots (kept as separate blobs, never inside the main state) ----
  if (req.method === 'GET' && url.searchParams.get('snapshots') === 'list') {
    try {
      const { blobs } = await store.list({ prefix: 'snap:' });
      const keys = (blobs || []).map(b => b.key).sort().reverse();
      return new Response(JSON.stringify({ snapshots: keys }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ snapshots: [] }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
  }
  if (req.method === 'GET' && url.searchParams.get('snapshot')) {
    try {
      const snap = await store.get(url.searchParams.get('snapshot'), { type: 'json' });
      return new Response(JSON.stringify(snap || null), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      return new Response(JSON.stringify(null), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
  }

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

  if (req.method === 'POST') {
    try {
      const body = await req.json();
      // Save a restore-point snapshot (its own blob), pruning to the newest 6
      if (body && body.saveSnapshot) {
        const key = 'snap:' + (body.saveSnapshot.date || new Date().toISOString());
        await store.setJSON(key, body.saveSnapshot);
        try {
          const { blobs } = await store.list({ prefix: 'snap:' });
          const keys = (blobs || []).map(b => b.key).sort().reverse();
          for (const k of keys.slice(6)) { await store.delete(k); }
        } catch (e) { /* pruning is best-effort */ }
        return new Response(JSON.stringify({ ok: true, key }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }
      // Normal save. The server owns the version counter — read current, write back version+1.
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
