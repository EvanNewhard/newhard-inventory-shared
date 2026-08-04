import { getStore } from '@netlify/blobs';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// ---------------------------------------------------------------------------
// Esh invoice email reader (PenTeleData / ptd.net, plain IMAP).
// All email access happens HERE, on the server, so the mailbox password is
// never exposed to the browser. No Google, no OAuth, no expiring tokens.
//
// Env vars required (Netlify -> Site configuration -> Environment variables):
//   PTD_EMAIL_USER  - the ptd.net login (the part before @ptd.net, or the full address)
//   PTD_EMAIL_PASS  - the mailbox password
//   PTD_IMAP_HOST   - optional, defaults to promail.ptd.net
//   PTD_IMAP_PORT   - optional, defaults to 993 (SSL)
//
// The Esh invoice email (confirmed from a real sample):
//   From:    noreply@eshfoods.com
//   Subject: Esh Foods, LLC Invoice Notification   (treated as constant)
//   Attachment: Invoice-<date>-<number>.pdf
// ---------------------------------------------------------------------------

const BUILD = 'email-2026-08-04-imap-v2';   // bump to verify deploys
const SENDER  = 'noreply@eshfoods.com';
const SUBJECT = 'Esh Foods, LLC Invoice Notification';

const json = (obj, status=200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' }
});

function store(){ return getStore('email'); }
async function loadCreds(){
  // Prefer credentials entered in the app (stored server-side in Blobs); fall back to env vars.
  try {
    const c = await store().get('creds', { type:'json' });
    if(c && c.user && c.pass) return { host:(c.host||'promail.ptd.net'), port:(c.port||993), user:c.user, pass:c.pass, source:'app' };
  } catch {}
  const eu = (process.env.PTD_EMAIL_USER||'').trim(), ep = (process.env.PTD_EMAIL_PASS||'').trim();
  if(eu && ep) return { host:(process.env.PTD_IMAP_HOST||'promail.ptd.net').trim(), port:parseInt(process.env.PTD_IMAP_PORT||'993',10), user:eu, pass:ep, source:'env' };
  return null;
}
async function saveCreds(c){ await store().setJSON('creds', c); }
async function clearCreds(){ try { await store().delete('creds'); } catch {} }

// Open an authenticated IMAP connection. Caller MUST call client.logout() when done.
async function connect(c){
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    tls: { rejectUnauthorized: false },
    socketTimeout: 20000,
  });
  await client.connect();
  return client;
}

// Search INBOX for Esh invoice messages, newest first. Returns lightweight rows (no PDF yet).
async function listInvoices(creds, limit=25){
  const client = await connect(creds);
  const rows = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search by sender; we filter the subject ourselves so a tiny subject variation can't hide it.
      const uids = await client.search({ from: SENDER }, { uid: true });
      const wanted = (uids || []).slice(-limit).reverse();   // newest first
      for(const uid of wanted){
        let msg = null;
        for await (const m of client.fetch({ uid }, { uid:true, envelope:true, bodyStructure:true }, { uid:true })){
          msg = m;
        }
        if(!msg || !msg.envelope) continue;
        const subj = (msg.envelope.subject || '').trim();
        if(SUBJECT && !subj.toLowerCase().includes('invoice')) continue;   // guard: must look like an invoice
        // Does it have a PDF attachment?
        const hasPdf = bodyHasPdf(msg.bodyStructure);
        rows.push({
          uid: String(msg.uid),
          subject: subj,
          date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
          from: (msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '',
          hasPdf,
        });
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(()=>{}); }
  return rows;
}

function bodyHasPdf(struct){
  if(!struct) return false;
  const walk = (node)=>{
    if(!node) return false;
    const type = ((node.type||'') + '/' + (node.subtype||'')).toLowerCase();
    const disp = (node.disposition||'').toLowerCase();
    const fname = (node.dispositionParameters && node.dispositionParameters.filename)
               || (node.parameters && node.parameters.name) || '';
    if(type === 'application/pdf' || /\.pdf$/i.test(fname)) return true;
    if(Array.isArray(node.childNodes)) return node.childNodes.some(walk);
    return false;
  };
  return walk(struct);
}

// Download a specific message and return its first PDF attachment as base64.
async function fetchPdf(creds, uid){
  const client = await connect(creds);
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const { content } = await client.download(uid, undefined, { uid:true });
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const parsed = await simpleParser(raw);
      const pdf = (parsed.attachments || []).find(a =>
        (a.contentType||'').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(a.filename||'')
      );
      if(!pdf) return { error: 'No PDF attachment found on that email.' };
      return {
        ok: true,
        filename: pdf.filename || 'invoice.pdf',
        base64: pdf.content.toString('base64'),
        subject: parsed.subject || '',
        date: parsed.date ? parsed.date.toISOString() : null,
      };
    } finally { lock.release(); }
  } finally { await client.logout().catch(()=>{}); }
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/email\/?/, '').replace(/\/$/, '');

  // Status — safe without creds; tells the client whether email is connected and to which address.
  if(path === 'status' && req.method === 'GET'){
    const c = await loadCreds();
    return json({ connected: !!c, build: BUILD, sender: SENDER, subject: SUBJECT,
                  host: c ? c.host : 'promail.ptd.net',
                  user: c ? maskUser(c.user) : null,
                  source: c ? c.source : null });
  }

  // Connect — the app posts {user, pass, host?}. We verify by actually logging in before saving,
  // so a bad password fails immediately instead of silently later.
  if(path === 'connect' && req.method === 'POST'){
    const b = await req.json().catch(()=>({}));
    const user = String(b.user||'').trim();
    const pass = String(b.pass||'').trim();
    const host = String(b.host||'promail.ptd.net').trim();
    const port = parseInt(b.port||'993',10) || 993;
    if(!user || !pass) return json({ error:'Enter both the email address/username and password.' }, 400);
    // Test the login before storing it.
    try {
      const client = await connect({ host, port, user, pass });
      await client.logout().catch(()=>{});
    } catch(e){
      const msg = String(e && e.message || e);
      return json({ error: /auth|login|credential|password|invalid/i.test(msg)
        ? 'That username or password was rejected by the mail server.'
        : ('Could not reach the mail server: ' + msg.slice(0,140)) }, 400);
    }
    await saveCreds({ user, pass, host, port });
    return json({ ok:true, user: maskUser(user), host });
  }

  if(path === 'disconnect' && req.method === 'POST'){
    await clearCreds();
    return json({ ok:true });
  }

  // Everything below needs a working connection.
  const creds = await loadCreds();
  if(!creds){
    return json({ error: 'Email is not connected. Open the email settings and connect a mailbox.' }, 400);
  }

  try {
    if(path === 'list' && req.method === 'GET'){
      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit')) || 25));
      const rows = await listInvoices(creds, limit);
      try { await store().setJSON('lastList', { at: Date.now(), rows }); } catch {}
      return json({ ok:true, count: rows.length, invoices: rows });
    }

    if(path === 'pdf' && req.method === 'GET'){
      const uid = (url.searchParams.get('uid') || '').trim();
      if(!uid) return json({ error:'Missing uid.' }, 400);
      const res = await fetchPdf(creds, uid);
      return json(res, res.ok ? 200 : 404);
    }

    if(path === 'latest' && req.method === 'GET'){
      const rows = await listInvoices(creds, 5);
      return json({ ok:true, latest: rows[0] || null });
    }

    return json({ error:'Unknown email endpoint.' }, 404);
  } catch(e){
    const msg = String(e && e.message || e);
    const safe = /auth|login|credential|password/i.test(msg)
      ? 'Could not sign in to the mailbox — the saved password may have changed. Reconnect in email settings.'
      : ('Email read failed: ' + msg.slice(0,160));
    return json({ error: safe }, 502);
  }
};

function maskUser(u){ if(!u) return null; const at=u.indexOf('@'); const name=at>=0?u.slice(0,at):u; return (name.slice(0,2)+'***'+(at>=0?u.slice(at):'')); }

export const config = { path: '/api/email/*' };
