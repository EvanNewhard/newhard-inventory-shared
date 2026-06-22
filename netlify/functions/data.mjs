import { getStore } from '@netlify/blobs';

export default async (req) => {
  const store = getStore('inventory');

  // GET: read the saved data
  if (req.method === 'GET') {
    try {
      const data = await store.get('state', { type: 'json' });
      return new Response(JSON.stringify(data || { items: {}, state: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ items: {}, state: {} }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // POST: save the current data
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      await store.setJSON('state', body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' }
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
