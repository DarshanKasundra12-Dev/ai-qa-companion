import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { chromium } from 'playwright';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Storage state cache ----------------------------------------------------
const STATE_DIR = path.join(os.tmpdir(), 'qaforge-states');
await fs.mkdir(STATE_DIR, { recursive: true }).catch(() => {});

function stateKey(userId, loginUrl, username) {
  return crypto.createHash('sha256').update(`${userId}::${loginUrl}::${username}`).digest('hex');
}
function stateFile(userId, loginUrl, username) {
  return path.join(STATE_DIR, `${stateKey(userId, loginUrl, username)}.json`);
}
async function loadStorageState(userId, loginUrl, username) {
  try { return JSON.parse(await fs.readFile(stateFile(userId, loginUrl, username), 'utf8')); }
  catch { return undefined; }
}
async function saveStorageState(userId, loginUrl, username, state) {
  await fs.writeFile(stateFile(userId, loginUrl, username), JSON.stringify(state));
}
async function clearStorageState(userId, loginUrl, username) {
  try { await fs.unlink(stateFile(userId, loginUrl, username)); } catch {}
}

async function loginAndCache(browser, { userId, loginUrl, username, password, selectors }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.fill(selectors.username, username, { timeout: 8000 });
    await page.fill(selectors.password, password, { timeout: 8000 });
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
      page.click(selectors.submit, { timeout: 8000 }),
    ]);
    const state = await ctx.storageState();
    await saveStorageState(userId, loginUrl, username, state);
    return state;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// --- API Tester proxy (kept) ------------------------------------------------
app.post('/proxy', async (req, res) => {
  const { url, method, headers, data } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const startTime = Date.now();
  try {
    const response = await axios({ url, method: method || 'GET', headers: headers || {}, data, validateStatus: () => true, timeout: 15000 });
    res.json({ status: response.status, statusText: response.statusText, headers: response.headers, data: response.data, timeMs: Date.now() - startTime, size: JSON.stringify(response.data)?.length || 0 });
  } catch (error) {
    res.json({ status: 0, statusText: 'Error', error: error.message, timeMs: Date.now() - startTime, size: 0 });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// --- Socket.io JWT auth (Supabase) -----------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const supabaseAuth = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

io.use(async (socket, next) => {
  // If Supabase isn't configured, allow (dev mode) but tag user as anonymous
  if (!supabaseAuth) {
    socket.data.userId = `anon-${socket.id}`;
    return next();
  }
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized: missing token'));
  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) return next(new Error('Unauthorized: invalid token'));
    socket.data.userId = data.user.id;
    next();
  } catch (e) {
    next(new Error('Unauthorized: ' + (e.message || 'auth failed')));
  }
});

// --- Browser (shared) -------------------------------------------------------
let browser;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id, 'user:', socket.data.userId);

  const VIEWPORT = { width: 1280, height: 800 };
  // Per-socket state (isolation)
  let context = null;
  let page = null;
  let cdpClient = null;
  let activeAuth = null; // { loginUrl, username, password, selectors }

  async function attachPageListeners(p) {
    p.on('request', request => {
      socket.emit('network_request', { url: request.url(), method: request.method(), resourceType: request.resourceType() });
    });
    p.on('response', async response => {
      try {
        const request = response.request();
        const headers = response.headers();
        const url = response.url();
        const issues = [];
        if (!headers['strict-transport-security'] && url.startsWith('https://')) {
          issues.push({ type: 'header', name: 'Missing HSTS', severity: 'Medium', details: 'Strict-Transport-Security header is missing.' });
        }
        if (!headers['x-frame-options'] && !headers['content-security-policy']?.includes('frame-ancestors')) {
          issues.push({ type: 'header', name: 'Missing Clickjacking Protection', severity: 'Medium', details: 'X-Frame-Options or CSP frame-ancestors is missing.' });
        }
        const setCookie = headers['set-cookie'];
        if (setCookie) {
          const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
          cookies.forEach(c => {
            if (!c.toLowerCase().includes('secure')) issues.push({ type: 'cookie', name: 'Insecure Cookie', severity: 'High', details: 'Cookie is missing the Secure flag.' });
            if (!c.toLowerCase().includes('httponly') && (c.toLowerCase().includes('session') || c.toLowerCase().includes('token'))) {
              issues.push({ type: 'cookie', name: 'Missing HttpOnly on Auth Cookie', severity: 'High', details: 'Potentially sensitive cookie missing HttpOnly flag.' });
            }
          });
        }
        let body = null;
        if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') {
          body = await response.text().catch(() => null);
          if (body && /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(body) && !url.includes('auth') && !url.includes('login')) {
            issues.push({ type: 'leak', name: 'Exposed JWT Token', severity: 'Critical', details: 'Found a JWT token in the response body of a non-auth endpoint.' });
          }
        }
        if (issues.length > 0) socket.emit('security_issues', { url, issues });
        if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') {
          socket.emit('network_response', { url: response.url(), status: response.status(), ok: response.ok(), body: body ? body.substring(0, 1000) : null });
        }
        // Detect 401 → suggest re-login
        if (response.status() === 401) {
          socket.emit('auth_expired', { url: response.url() });
        }
      } catch (error) { console.error('response capture', error); }
    });
  }

  async function injectInspector(p) {
    await p.exposeFunction('onElementSelected', (elData) => socket.emit('element_selected', elData));
    await p.addStyleTag({ content: `.qaforge-highlight{outline:2px dashed #ff00ff !important;background-color:rgba(255,0,255,0.1) !important;cursor:crosshair !important;}` });
    await p.addScriptTag({ content: `
      window.__qaforgeMode = 'interact';

      // ---- Universal fingerprint helpers (record + resolve share this code) ----
      const ICON_RE = {
        edit:   /edit|pencil/i,
        delete: /delete|trash|remove|bin/i,
        close:  /close|dismiss|^x$|x-mark|cross/i,
        menu:   /menu|more|kebab|dots|ellipsis/i,
        search: /search|magnify/i,
        add:    /add|plus|create|new/i,
        back:   /back|chevron-left|arrow-left/i,
        next:   /next|chevron-right|arrow-right/i,
      };
      function __hash(s){let h=0;for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;}return Math.abs(h).toString(36);}
      function __detectIcon(el){
        const btn = el.closest('button,a,[role=button]') || el;
        const sig = [
          btn.getAttribute('aria-label'), btn.getAttribute('title'),
          btn.getAttribute('data-testid'), btn.className,
          btn.querySelector('svg')?.getAttribute('class') || '',
          btn.querySelector('use')?.getAttribute('href') || '',
          btn.querySelector('i')?.className || '',
        ].filter(Boolean).join(' ');
        for (const [name, re] of Object.entries(ICON_RE)) if (re.test(sig)) return name;
        const d = btn.querySelector('svg path[d]')?.getAttribute('d');
        return d ? 'svg:' + __hash(d.slice(0,80)) : null;
      }
      function __computedRole(el){
        const r = el.getAttribute('role'); if (r) return r;
        const t = el.tagName.toLowerCase();
        if (t==='a' && el.hasAttribute('href')) return 'link';
        if (t==='button') return 'button';
        if (t==='input'){ const ty=(el.getAttribute('type')||'text').toLowerCase(); return ty==='checkbox'||ty==='radio'||ty==='button'||ty==='submit'?ty:'textbox'; }
        if (t==='select') return 'combobox';
        if (t==='textarea') return 'textbox';
        return null;
      }
      function __accName(el){
        return (el.getAttribute('aria-label') || el.getAttribute('title') ||
                (el.innerText || '').trim().slice(0,80) || el.getAttribute('alt') ||
                el.getAttribute('placeholder') || '').trim();
      }
      function __containerOf(el){
        return el.closest('[role=row],tr,li,[role=listitem],article,[data-row],[data-id]');
      }
      function __keyText(container){
        if (!container) return null;
        const t = (container.innerText || '').trim().replace(/\\s+/g,' ');
        return t.slice(0, 120) || null;
      }
      function __isVisible(el){
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = getComputedStyle(el);
        return s.display!=='none' && s.visibility!=='hidden' && s.opacity!=='0';
      }
      function __ancestorRoles(el, max=4){
        const out=[]; let p=el.parentElement;
        while(p && out.length<max){ const r=__computedRole(p); if(r) out.push(r); p=p.parentElement; }
        return out;
      }
      function __buildFingerprint(target){
        // Normalize svg/icon clicks → closest real actionable
        const norm = target.closest('button,a,[role=button],[role=link],[role=menuitem],input,select,textarea,[tabindex]') || target;
        const container = __containerOf(norm);
        return {
          tagName: norm.tagName,
          role: __computedRole(norm),
          accessibleName: __accName(norm),
          visibleText: (norm.innerText||'').trim().slice(0,80),
          iconClass: __detectIcon(norm),
          testId: norm.getAttribute('data-testid') || undefined,
          ariaLabel: norm.getAttribute('aria-label') || undefined,
          name: norm.getAttribute('name') || undefined,
          href: norm.getAttribute('href') || undefined,
          placeholder: norm.getAttribute('placeholder') || undefined,
          containerRole: container ? (__computedRole(container) || container.tagName.toLowerCase()) : undefined,
          containerKeyText: __keyText(container),
          ancestorRoles: __ancestorRoles(norm),
        };
      }
      // Expose to the resolver (called from page.evaluate at replay time)
      window.__qaforgeBuildFingerprint = __buildFingerprint;
      window.__qaforgeResolve = function(fp){
        let scope = document;
        if (fp.containerKeyText) {
          const containers = document.querySelectorAll('[role=row],tr,li,[role=listitem],article,[data-row],[data-id]');
          for (const c of containers) {
            if ((c.innerText||'').includes(fp.containerKeyText)) { scope = c; break; }
          }
        }
        const cands = scope.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],input,select,textarea,[tabindex]');
        let best=null, bestScore=-1;
        for (const el of cands) {
          if (!__isVisible(el)) continue;
          let s = 0;
          if (fp.testId && el.getAttribute('data-testid')===fp.testId) s += 100;
          if (fp.ariaLabel && el.getAttribute('aria-label')===fp.ariaLabel) s += 50;
          if (fp.name && el.getAttribute('name')===fp.name) s += 40;
          if (fp.href && el.getAttribute('href')===fp.href) s += 30;
          if (fp.role && __computedRole(el)===fp.role) s += 20;
          if (fp.accessibleName && __accName(el)===fp.accessibleName) s += 40;
          if (fp.visibleText && (el.innerText||'').trim().slice(0,80)===fp.visibleText) s += 25;
          if (fp.iconClass && __detectIcon(el)===fp.iconClass) s += 30;
          if (fp.tagName && el.tagName===fp.tagName) s += 5;
          if (fp.placeholder && el.getAttribute('placeholder')===fp.placeholder) s += 25;
          if (s > bestScore) { bestScore = s; best = el; }
        }
        if (!best || bestScore < 25) return null;
        // Tag for Playwright to grab
        best.setAttribute('data-qaforge-target', '1');
        return { score: bestScore, tag: best.tagName, text: (best.innerText||'').slice(0,40) };
      };

      // ---- Inspector hover/click ----
      let highlightedElement = null;
      document.addEventListener('mouseover', (e) => {
        if (window.__qaforgeMode !== 'inspect') return;
        if (highlightedElement) highlightedElement.classList.remove('qaforge-highlight');
        highlightedElement = e.target; highlightedElement.classList.add('qaforge-highlight');
      }, true);
      document.addEventListener('mouseout', () => { if (highlightedElement) { highlightedElement.classList.remove('qaforge-highlight'); highlightedElement = null; } }, true);
      document.addEventListener('click', (e) => {
        if (window.__qaforgeMode !== 'inspect') return;
        e.preventDefault(); e.stopPropagation();
        try { window.onElementSelected(__buildFingerprint(e.target)); }
        catch (err) { console.error('qaforge fingerprint', err); }
      }, true);
    ` });
  }

  async function startScreencast(ctx, p) {
    try {
      const client = await ctx.newCDPSession(p);
      cdpClient = client;
      await client.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
      client.on('Page.screencastFrame', async (f) => {
        socket.emit('screencast_frame', { data: f.data });
        await client.send('Page.screencastFrameAck', { sessionId: f.sessionId });
      });
    } catch (e) { console.error('screencast', e); }
  }

  async function teardown() {
    try { if (cdpClient) { await cdpClient.detach().catch(()=>{}); cdpClient = null; } } catch {}
    if (page) { await page.close().catch(()=>{}); page = null; }
    if (context) { await context.close().catch(()=>{}); context = null; }
  }

  socket.on('start_session', async ({ url, auth }) => {
    try {
      await teardown(); // clean previous
      const b = await getBrowser();

      // Resolve storageState if auth recipe is provided
      let storageState;
      if (auth?.loginUrl && auth?.username) {
        activeAuth = auth;
        storageState = await loadStorageState(socket.data.userId, auth.loginUrl, auth.username);
        if (!storageState && auth.password && auth.selectors?.username && auth.selectors?.password && auth.selectors?.submit) {
          socket.emit('auth_status', { stage: 'logging_in' });
          try {
            storageState = await loginAndCache(b, { userId: socket.data.userId, ...auth });
            socket.emit('auth_status', { stage: 'logged_in' });
          } catch (e) {
            socket.emit('auth_status', { stage: 'login_failed', error: e.message });
          }
        } else if (storageState) {
          socket.emit('auth_status', { stage: 'using_cached' });
        }
      }

      context = await b.newContext({ viewport: VIEWPORT, storageState });
      page = await context.newPage();
      socket.emit('viewport_info', VIEWPORT);

      await attachPageListeners(page);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await injectInspector(page);
      await startScreencast(context, page);

      socket.emit('session_started', { success: true, url });
    } catch (error) {
      console.error(error);
      socket.emit('session_started', { success: false, error: error.message });
    }
  });

  // Force re-login: clear cached state and re-run the login recipe
  socket.on('relogin', async () => {
    if (!activeAuth?.loginUrl || !activeAuth?.username) {
      return socket.emit('auth_status', { stage: 'login_failed', error: 'No login recipe configured for this session' });
    }
    try {
      await clearStorageState(socket.data.userId, activeAuth.loginUrl, activeAuth.username);
      const b = await getBrowser();
      socket.emit('auth_status', { stage: 'logging_in' });
      const storageState = await loginAndCache(b, { userId: socket.data.userId, ...activeAuth });
      socket.emit('auth_status', { stage: 'logged_in' });
      // Reload current page with fresh context
      const currentUrl = page ? page.url() : activeAuth.loginUrl;
      await teardown();
      context = await b.newContext({ viewport: VIEWPORT, storageState });
      page = await context.newPage();
      await attachPageListeners(page);
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
      await injectInspector(page);
      await startScreencast(context, page);
      socket.emit('session_started', { success: true, url: currentUrl });
    } catch (e) {
      socket.emit('auth_status', { stage: 'login_failed', error: e.message });
    }
  });

  socket.on('run_flow', async ({ url, steps }) => {
    try {
      await teardown();
      const b = await getBrowser();
      context = await b.newContext();
      page = await context.newPage();
      socket.emit('run_started', { url });
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        socket.emit('step_running', { stepId: step.id });
        try {
          if (step.kind === 'navigate') await page.goto(step.value || url, { waitUntil: 'domcontentloaded' });
          else if (step.kind === 'wait') await page.waitForTimeout(parseInt(step.value || '1000'));
          else if (step.kind === 'click' && step.selector) {
            try { await page.click(step.selector, { timeout: 3000 }); }
            catch {
              socket.emit('step_healing', { stepId: step.id, oldSelector: step.selector });
              const dom = await page.evaluate(() => document.body.innerHTML);
              const prompt = `The UI test failed to click on "${step.selector}". Here is the page HTML:\n${dom.substring(0, 15000)}\nFind a robust alternative selector for this element. Return only the string for the selector.`;
              let newSelector = '';
              const apiKey = process.env.GEMINI_API_KEY;
              if (apiKey && apiKey.startsWith('gsk_')) {
                const groq = new Groq({ apiKey });
                const r = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] });
                newSelector = r.choices?.[0]?.message?.content?.trim() || '';
              } else { throw new Error('No Groq key configured in GEMINI_API_KEY env'); }
              if (newSelector.startsWith('```')) newSelector = newSelector.replace(/```[a-z]*\n?/g, '').replace(/\n?```$/g, '');
              socket.emit('step_healed', { stepId: step.id, oldSelector: step.selector, newSelector });
              await page.click(newSelector, { timeout: 3000 });
            }
          } else if (step.kind === 'input' && step.selector) {
            await page.fill(step.selector, step.value || '', { timeout: 3000 });
          }
          socket.emit('step_completed', { stepId: step.id, status: 'pass' });
        } catch (error) {
          socket.emit('step_completed', { stepId: step.id, status: 'fail', error: error.message });
          break;
        }
      }
      socket.emit('run_finished', { success: true });
    } catch (error) {
      socket.emit('run_finished', { success: false, error: error.message });
    }
  });

  socket.on('set_mode', async ({ mode }) => {
    if (!page) return;
    try { await page.evaluate((m) => { window.__qaforgeMode = m; }, mode); } catch {}
  });

  socket.on('forward_click', async ({ x, y, button }) => {
    if (!page) return;
    try { await page.mouse.click(Math.round(x), Math.round(y), { button: button || 'left' }); } catch (e) { console.error('forward_click', e.message); }
  });
  socket.on('inspect_click', async ({ x, y, button }) => {
    if (!page) return;
    try { await page.mouse.click(Math.round(x), Math.round(y), { button: button || 'left' }); } catch (e) { console.error('inspect_click', e.message); }
  });
  socket.on('forward_scroll', async ({ x, y, deltaX, deltaY }) => {
    if (!page) return;
    try { await page.mouse.move(Math.round(x), Math.round(y)); await page.mouse.wheel(deltaX || 0, deltaY || 0); } catch (e) { console.error('forward_scroll', e.message); }
  });
  socket.on('forward_move', async ({ x, y }) => { if (!page) return; try { await page.mouse.move(Math.round(x), Math.round(y)); } catch {} });
  socket.on('forward_key', async ({ key }) => { if (!page) return; try { await page.keyboard.press(key); } catch (e) { console.error('forward_key', e.message); } });
  socket.on('forward_type', async ({ text }) => { if (!page) return; try { await page.keyboard.type(text); } catch (e) { console.error('forward_type', e.message); } });

  socket.on('stop_session', async () => { await teardown(); socket.emit('session_stopped'); });
  socket.on('disconnect', async () => { console.log('Client disconnected:', socket.id); await teardown(); });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`Automation Server running on port ${PORT}`));
