import { getStore } from '@netlify/blobs';

// ---------------------------------------------------------------------------
// Clover integration (v2 OAuth). All Clover calls happen HERE, on the server,
// so the App Secret and access tokens are never exposed to the browser.
//
// Env vars required (set in Netlify → Site configuration → Environment variables):
//   CLOVER_APP_ID       – the Clover app's App ID
//   CLOVER_APP_SECRET   – the Clover app's App Secret
//
// Stored blob 'clover' key 'auth':
//   { merchantId, accessToken, refreshToken, accessExpiry, refreshExpiry,
//     environment ('sandbox'|'production'), enabled, paused, connectedAt, lastPull, lastPush }
// ---------------------------------------------------------------------------

const SITE = 'https://adorable-cajeta-d1c42f.netlify.app';
const REDIRECT_URI = SITE + '/api/clover/callback';
const BUILD = 'clover-2026-07-07-d'; // bump to verify deploys
const APP_ID = () => (process.env.CLOVER_APP_ID||'').trim();
const APP_SECRET = () => (process.env.CLOVER_APP_SECRET||'').trim();

// Clover splits these hosts. Critically, in the SANDBOX the v2 token exchange must hit
// apisandbox.dev.clover.com (NOT sandbox.dev.clover.com) or it 401s "Failed to validate
// authentication code" — a well-known Clover gotcha. We use apisandbox for the whole sandbox flow.
const HOSTS = {
  sandbox:    { authorize: 'https://apisandbox.dev.clover.com', token: 'https://apisandbox.dev.clover.com', api: 'https://apisandbox.dev.clover.com' },
  production: { authorize: 'https://www.clover.com',            token: 'https://api.clover.com',            api: 'https://api.clover.com' },
};

const json = (obj, status=200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const redirect = (url) => new Response(null, { status: 302, headers: { Location: url } });

function store(){ return getStore('clover'); }
async function loadAuth(){ try { return (await store().get('auth', { type:'json' })) || null; } catch { return null; } }
async function saveAuth(a){ await store().setJSON('auth', a); }
async function clearAuth(){ try { await store().delete('auth'); } catch {} }

// Exchange an authorization code for an access/refresh token pair
async function exchangeCode(env, code){
  const host = HOSTS[env].token;
  const r = await fetch(host + '/oauth/v2/token', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({
      client_id: APP_ID(),
      client_secret: APP_SECRET(),
      code
    })
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error('token exchange failed at ' + host + ': ' + r.status + ' ' + JSON.stringify(data));
  return data; // { access_token, access_token_expiration, refresh_token, refresh_token_expiration }
}

// Refresh the token pair (refresh tokens are single-use; we always save the new pair)
async function refreshTokens(auth){
  const host = HOSTS[auth.environment].token;
  const r = await fetch(host + '/oauth/v2/refresh', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ client_id: APP_ID(), refresh_token: auth.refreshToken })
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error('token refresh failed: ' + r.status + ' ' + JSON.stringify(data));
  auth.accessToken   = data.access_token;
  auth.refreshToken  = data.refresh_token || auth.refreshToken;
  auth.accessExpiry  = (data.access_token_expiration || 0) * 1000;
  auth.refreshExpiry = (data.refresh_token_expiration || 0) * 1000;
  await saveAuth(auth);
  return auth;
}

// Get a valid auth object, refreshing the access token if it's expired or about to be
async function validAuth(){
  let auth = await loadAuth();
  if(!auth || !auth.accessToken) return null;
  if(auth.tokenType === 'merchant') return auth; // pasted merchant tokens don't use the refresh flow
  const now = Date.now();
  if(auth.accessExpiry && now > auth.accessExpiry - 90*1000){ // refresh 90s before expiry
    auth = await refreshTokens(auth);
  }
  return auth;
}

// A Clover REST call with the bearer token
async function cloverGet(auth, path){
  const r = await fetch(HOSTS[auth.environment].api + path, {
    headers: { Authorization: 'Bearer ' + auth.accessToken, 'Content-Type':'application/json' }
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error('Clover GET ' + path + ' → ' + r.status + ' ' + JSON.stringify(data).slice(0,300));
  return data;
}
async function cloverPost(auth, path, body){
  const r = await fetch(HOSTS[auth.environment].api + path, {
    method:'POST',
    headers: { Authorization: 'Bearer ' + auth.accessToken, 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error('Clover POST ' + path + ' → ' + r.status + ' ' + JSON.stringify(data).slice(0,300));
  return data;
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/clover\/?/, '').replace(/\/$/,''); // sub-path
  const haveCreds = !!(process.env.CLOVER_APP_ID && process.env.CLOVER_APP_SECRET);

  try {
    // ---- STATUS: what the Connect button shows -------------------------------
    if(path === 'status' && req.method === 'GET'){
      const auth = await loadAuth();
      const out = {
        configured: haveCreds,
        build: BUILD,
        sandboxTokenHost: HOSTS.sandbox.token,
        connected: !!(auth && auth.accessToken),
        merchantId: auth ? auth.merchantId : null,
        environment: auth ? auth.environment : 'sandbox',
        enabled: auth ? auth.enabled !== false : false,
        paused: auth ? !!auth.paused : false,
        connectedAt: auth ? auth.connectedAt : null,
        lastPull: auth ? auth.lastPull : null,
        lastPush: auth ? auth.lastPush : null,
        refreshExpiry: auth ? auth.refreshExpiry : null,
      };
      // ?debug=1 → non-sensitive credential shape check (App ID is not secret; it's in OAuth URLs).
      if(url.searchParams.get('debug') === '1'){
        const id = process.env.CLOVER_APP_ID || '';
        const sec = process.env.CLOVER_APP_SECRET || '';
        out.debug = {
          appId: id,                                  // compare this to your Clover app's App ID
          appIdHasWhitespace: id !== id.trim(),
          secretLen: sec.length,                      // a Clover secret is 36 chars (like the App ID)
          secretHasWhitespace: sec !== sec.trim(),
          secretHead: sec.slice(0,4),                 // first 4 only, to confirm it's the right one
        };
      }
      return json(out);
    }

    // ---- START: browser hits this to begin the Clover login ------------------
    if(path === 'start'){
      if(!haveCreds) return json({ error:'Clover App ID/Secret are not set in Netlify environment variables.' }, 400);
      const env = (url.searchParams.get('env') === 'production') ? 'production' : 'sandbox';
      // remember which environment we're connecting for, so the callback knows
      await store().setJSON('pending', { environment: env, at: Date.now(), retried: false });
      // NOTE: we deliberately do NOT pass redirect_uri here. Clover uses the app's configured
      // Site URL for the redirect, and its /oauth/v2/token step does not accept a redirect_uri —
      // passing one at authorize but not at token causes a 401 "Failed to validate auth code".
      const authorizeUrl = HOSTS[env].authorize + '/oauth/v2/authorize'
        + '?client_id=' + encodeURIComponent(APP_ID())
        + '&response_type=code';
      return redirect(authorizeUrl);
    }

    // ---- CALLBACK: Clover redirects here with ?code=…&merchant_id=… -----------
    if(path === 'callback'){
      const code = url.searchParams.get('code');
      const merchantId = url.searchParams.get('merchant_id') || url.searchParams.get('mId');
      const pending = await store().get('pending', { type:'json' }).catch(()=>null);
      const env = (pending && pending.environment) || 'sandbox';
      // If Clover launched us with a merchant but no code (dashboard launch), kick off a proper
      // authorize to get a real code.
      if(!code){
        if(merchantId && !(pending && pending.retried)){
          await store().setJSON('pending', { environment: env, at: Date.now(), retried: true });
          return redirect(HOSTS[env].authorize + '/oauth/v2/authorize?client_id=' + encodeURIComponent(APP_ID()) + '&response_type=code');
        }
        return redirect(SITE + '/?clover=error&msg=' + encodeURIComponent('No authorization code returned by Clover.'));
      }
      try {
        const tok = await exchangeCode(env, code);
        const auth = {
          merchantId,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          accessExpiry: (tok.access_token_expiration || 0) * 1000,
          refreshExpiry: (tok.refresh_token_expiration || 0) * 1000,
          environment: env,
          enabled: true,
          paused: false,
          connectedAt: new Date().toISOString(),
          lastPull: null, lastPush: null,
        };
        await saveAuth(auth);
        await store().delete('pending').catch(()=>{});
        return redirect(SITE + '/?clover=connected');
      } catch(e){
        // Clover's first code right after install can fail; a second authorize returns a good one.
        if(!(pending && pending.retried)){
          await store().setJSON('pending', { environment: env, at: Date.now(), retried: true });
          return redirect(HOSTS[env].authorize + '/oauth/v2/authorize?client_id=' + encodeURIComponent(APP_ID()) + '&response_type=code');
        }
        return redirect(SITE + '/?clover=error&msg=' + encodeURIComponent(String(e.message||e).slice(0,200)));
      }
    }

    // ---- CONNECT WITH A PASTED MERCHANT TOKEN (recommended for a single store) ----
    if(path === 'connect-token' && req.method === 'POST'){
      const body = await req.json().catch(()=>({}));
      const merchantId = String(body.merchantId||'').trim();
      const token = String(body.token||'').trim();
      const env = body.environment === 'production' ? 'production' : 'sandbox';
      if(!merchantId || !token) return json({ error:'Enter both your Merchant ID and API token.' }, 400);
      // Validate by making one real read with the token before saving it
      const testAuth = { merchantId, accessToken: token, environment: env };
      try {
        const m = await cloverGet(testAuth, `/v3/merchants/${merchantId}`);
        const auth = {
          merchantId, accessToken: token, refreshToken: null,
          accessExpiry: 0, refreshExpiry: 0, environment: env, tokenType: 'merchant',
          enabled: true, paused: false, connectedAt: new Date().toISOString(), lastPull: null, lastPush: null,
        };
        await saveAuth(auth);
        return json({ ok:true, merchantName: (m && m.name) || null });
      } catch(e){
        return json({ error:'That token or Merchant ID didn’t work. Double-check both (and that the token has Inventory permission). Details: ' + String(e.message||e).slice(0,180) }, 400);
      }
    }

    // ---- DISCONNECT / PAUSE / RESUME ----------------------------------------
    if(path === 'disconnect' && req.method === 'POST'){ await clearAuth(); return json({ ok:true }); }
    if(path === 'pause' && req.method === 'POST'){
      const auth = await loadAuth(); if(!auth) return json({ ok:false, error:'not connected' },400);
      const body = await req.json().catch(()=>({}));
      auth.paused = !!body.paused; await saveAuth(auth); return json({ ok:true, paused: auth.paused });
    }

    // ---- PULL: fetch items + stock + categories from Clover ------------------
    if(path === 'pull' && req.method === 'GET'){
      const auth = await validAuth();
      if(!auth) return json({ error:'Not connected to Clover.' }, 400);
      if(auth.paused) return json({ error:'Clover sync is paused.' }, 400);
      const mId = auth.merchantId;
      let items = [], offset = 0, limit = 1000, guard = 0;
      while(guard++ < 20){
        const page = await cloverGet(auth, `/v3/merchants/${mId}/items?expand=categories,itemStock,options&limit=${limit}&offset=${offset}`);
        const els = (page && page.elements) || [];
        items = items.concat(els);
        if(els.length < limit) break;
        offset += limit;
      }
      // Normalize to a shape the website understands
      const out = items.map(it => ({
        id: it.id,
        name: it.name,
        price: (typeof it.price === 'number') ? it.price/100 : null, // Clover price is in cents
        productCode: it.code || it.sku || '',
        category: (it.categories && it.categories.elements && it.categories.elements[0] && it.categories.elements[0].name) || '',
        stock: (it.itemStock && typeof it.itemStock.quantity === 'number') ? it.itemStock.quantity
             : (it.itemStock && typeof it.itemStock.stockCount === 'number') ? it.itemStock.stockCount : null,
        tracked: !!(it.itemStock && (it.itemStock.quantity != null || it.itemStock.stockCount != null)),
        hidden: !!it.hidden,
      }));
      auth.lastPull = new Date().toISOString(); await saveAuth(auth);
      return json({ ok:true, count: out.length, items: out, merchantId: mId });
    }

    // ---- PUSH: write a batch of stock counts back to Clover -------------------
    // Body: { updates: [ { id, quantity }, ... ] }  (send in small batches from the client)
    if(path === 'push' && req.method === 'POST'){
      const auth = await validAuth();
      if(!auth) return json({ error:'Not connected to Clover.' }, 400);
      if(auth.paused) return json({ error:'Clover sync is paused.' }, 400);
      const mId = auth.merchantId;
      const body = await req.json().catch(()=>({}));
      const updates = Array.isArray(body.updates) ? body.updates : [];
      const results = [];
      for(const u of updates){
        try {
          await cloverPost(auth, `/v3/merchants/${mId}/item_stocks/${u.id}`, { quantity: Number(u.quantity) });
          results.push({ id: u.id, ok:true });
        } catch(e){
          results.push({ id: u.id, ok:false, error: String(e.message||e).slice(0,200) });
        }
        await new Promise(res=>setTimeout(res, 120)); // gentle throttle for rate limits
      }
      auth.lastPush = new Date().toISOString(); await saveAuth(auth);
      const failed = results.filter(r=>!r.ok);
      return json({ ok: failed.length===0, done: results.length, failed: failed.length, results });
    }

    return json({ error:'Unknown Clover endpoint.' }, 404);
  } catch(e){
    return json({ error: String(e.message||e).slice(0,300) }, 500);
  }
};

export const config = { path: '/api/clover/*' };
