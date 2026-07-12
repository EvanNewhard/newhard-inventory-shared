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
      // A missing blob (null) is a genuine fresh install â empty at version 0.
      const out = data || { items: {}, state: {}, version: 0 };
      if (out.version == null) out.version = 0;
      return new Response(JSON.stringify(out), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      // A real read ERROR must NOT look like "no data" â return 500 so the client knows the load
      // failed and does not treat it as a fresh install (which could lead to an empty overwrite).
      return new Response(JSON.stringify({ error: 'read-failed', detail: String(e) }), {
        status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
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
      // Normal save. The server owns the version counter â read current, write back version+1.
      let current = null;
      try {
        current = await store.get('state', { type: 'json' });
      } catch (e) {
        // We couldn't read the current state, so we CAN'T safely confirm we won't clobber good
        // data. Refuse the save and tell the client to retry â never write blind.
        return new Response(JSON.stringify({ ok: false, error: 'read-failed-abort' }), {
          status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }
      const prevVersion = (current && typeof current.version === 'number') ? current.version : 0;
      const prevCount = (current && current.items) ? Object.keys(current.items).length : 0;
      const newCount = (body && body.items) ? Object.keys(body.items).length : 0;
      // HARD GUARD: never overwrite a populated catalog with an empty one. This is the last line of
      // defense against the "reopened and lost everything" bug â no client can wipe the data.
      if (prevCount > 0 && newCount === 0) {
        return new Response(JSON.stringify({ ok: false, error: 'refused-empty-overwrite', version: prevVersion }), {
          status: 409, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }
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
