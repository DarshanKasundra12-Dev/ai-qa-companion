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

function escapeCssSelector(selector) {
  if (!selector) return selector;

  if (selector.startsWith('id(') || selector.startsWith('/')) {
    return 'xpath=' + selector;
  }

  if (selector.startsWith('xpath=') || selector.startsWith('text=') || selector.startsWith('role=') || selector.startsWith('data-testid=')) {
    return selector;
  }

  const pseudoClasses = new Set([
    'hover', 'active', 'focus', 'focus-within', 'focus-visible', 'visited', 'link', 'target',
    'enabled', 'disabled', 'checked', 'required', 'valid', 'invalid', 'optional', 'read-only',
    'read-write', 'first-child', 'last-child', 'only-child', 'nth-child', 'nth-last-child',
    'first-of-type', 'last-of-type', 'only-of-type', 'nth-of-type', 'nth-last-of-type',
    'empty', 'root', 'not', 'has', 'is', 'where', 'visible', 'hidden', 'has-text', 'text',
    'nth', 'left-of', 'right-of', 'above', 'below', 'near', 'before', 'after'
  ]);

  let result = '';
  let i = 0;
  const n = selector.length;

  while (i < n) {
    const char = selector[i];

    if (char === '[') {
      let bracketCount = 1;
      result += char;
      i++;
      while (i < n && bracketCount > 0) {
        const c = selector[i];
        result += c;
        if (c === '[') bracketCount++;
        else if (c === ']') bracketCount--;
        i++;
      }
    } else if (char === '.' || char === '#') {
      result += char;
      i++;
      let name = '';
      while (i < n) {
        const c = selector[i];

        if (c === '.' || c === '#' || c === '[' || c === ' ' || c === '>' || c === '+' || c === '~' || c === ',') {
          // If it's a '[' preceded by a '-', it's a Tailwind arbitrary value block
          if (c === '[' && name.endsWith('-')) {
            name += '\\[';
            i++;
            let bracketCount = 1;
            while (i < n && bracketCount > 0) {
              const charInBracket = selector[i];
              if (charInBracket === '[') {
                bracketCount++;
                name += '\\[';
              } else if (charInBracket === ']') {
                bracketCount--;
                name += '\\]';
              } else {
                if (charInBracket === '#') name += '\\#';
                else if (charInBracket === ':') name += '\\:';
                else if (charInBracket === '/') name += '\\/';
                else if (charInBracket === '.') name += '\\.';
                else if (charInBracket === '%') name += '\\%';
                else if (charInBracket === '(') name += '\\(';
                else if (charInBracket === ')') name += '\\)';
                else name += charInBracket;
              }
              i++;
            }
            continue;
          }
          break;
        }

        if (c === '\\') {
          name += c;
          if (i + 1 < n) {
            name += selector[i + 1];
            i++;
          }
          i++;
          continue;
        }

        if (c === ':') {
          let nextWord = '';
          let j = i + 1;
          while (j < n && /[a-zA-Z-]/.test(selector[j])) {
            nextWord += selector[j];
            j++;
          }
          if (pseudoClasses.has(nextWord.toLowerCase())) {
            break;
          } else {
            name += '\\:';
            i++;
            continue;
          }
        }

        if (c === '/') {
          name += '\\/';
        } else if (c === '%') {
          name += '\\%';
        } else if (c === '(') {
          name += '\\(';
        } else if (c === ')') {
          name += '\\)';
        } else {
          name += c;
        }
        i++;
      }
      result += name;
    } else {
      result += char;
      i++;
    }
  }
  return result;
}

const app = express();
app.use(cors());
app.use(express.json());

// --- Storage state cache ----------------------------------------------------
const STATE_DIR = path.join(os.tmpdir(), 'qaforge-states');
await fs.mkdir(STATE_DIR, { recursive: true }).catch(() => { });

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
  try { await fs.unlink(stateFile(userId, loginUrl, username)); } catch { }
}

async function loginAndCache(browser, { userId, loginUrl, username, password, selectors }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.fill(selectors.username, username, { timeout: 8000 });
    await page.fill(selectors.password, password, { timeout: 8000 });
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { }),
      page.click(selectors.submit, { timeout: 8000 }),
    ]);
    const state = await ctx.storageState();
    await saveStorageState(userId, loginUrl, username, state);
    return state;
  } finally {
    await ctx.close().catch(() => { });
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
    // Dialog handling
    p.on('dialog', async (dialog) => {
      const type = dialog.type();
      const msg = dialog.message();
      console.log(`🔔 Session dialog detected: [${type}] "${msg}"`);
      socket.emit('popup_detected', { type: 'dialog', dialogType: type, message: msg });
      try {
        if (type === 'prompt') {
          await dialog.accept('');
        } else {
          await dialog.accept();
        }
      } catch (e) {
        console.error(`Could not dismiss session dialog: ${e.message}`);
      }
    });

    // Network request tracking
    p.on('request', request => {
      socket.emit('network_request', { url: request.url(), method: request.method(), resourceType: request.resourceType() });
    });

    // Network response tracking & security auditing
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

    // Expose interaction recorders to the page context
    await p.exposeFunction('onInteractionRecorded', (data) => {
      socket.emit('interaction_recorded', data);
    });

    // Navigation tracking
    let isInitialNavigation = true;
    p.on('framenavigated', async (frame) => {
      if (frame === p.mainFrame()) {
        const url = frame.url();
        if (url && url !== 'about:blank') {
          if (isInitialNavigation) {
            isInitialNavigation = false;
            return;
          }
          // Wait for the new page to finish loading before emitting the navigate step
          try {
            await p.waitForLoadState('domcontentloaded', { timeout: 10000 });
            await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
            // Small settle time for dynamic content
            await p.waitForTimeout(500);
          } catch (e) {
            // Timeout is ok — emit navigate anyway
          }
          socket.emit('interaction_recorded', {
            kind: 'navigate',
            value: url
          });
        }
      }
    });
  }

  async function injectInspector(p) {
    await p.addStyleTag({
      content: `
      .qaforge-highlight {
        outline: 2px dashed #ff00ff !important;
        background-color: rgba(255, 0, 255, 0.1) !important;
        cursor: crosshair !important;
      }
    ` });

    await p.addScriptTag({
      content: `
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
      function __xpath(el){ if(el.id) return 'id("'+el.id+'")'; if(el===document.body) return el.tagName; let ix=0; const sib=el.parentNode?.childNodes||[]; for(let i=0;i<sib.length;i++){const s=sib[i]; if(s===el) return __xpath(el.parentNode)+'/'+el.tagName+'['+(ix+1)+']'; if(s.nodeType===1 && s.tagName===el.tagName) ix++;} return el.tagName; }
      function getXPath(el) { return __xpath(el); }
      
      // Helper: detect auto-generated IDs that are unreliable as selectors
      function isSemanticId(id) {
        if (!id) return false;
        if (id.startsWith(':r') && id.endsWith(':')) return false; // React 18 auto IDs
        if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false; // UUID/GUID
        if (/^(ember|jquery|radix|react-aria|next|__next|nuxt|gatsby|vue-aria|headlessui)-\\d+/i.test(id)) return false;
        if (/[a-zA-Z]+-?\\d{2,}$/.test(id)) return false; // ember247, component-99
        if (/^\\d+$/.test(id)) return false; // purely numeric
        return true;
      }

      // Bubble up to nearest interactive ancestor
      function resolveInteractiveTarget(target) {
        if (!target) return target;
        const svgTags = new Set(['SVG', 'PATH', 'CIRCLE', 'LINE', 'POLYLINE', 'POLYGON', 'RECT', 'ELLIPSE', 'G', 'USE']);
        if (!svgTags.has(target.tagName)) return target;

        let el = target;
        while (el && el !== document.body) {
          if (el.tagName === 'BUTTON' || el.tagName === 'A' ||
              el.getAttribute('role') === 'button' ||
              el.getAttribute('role') === 'link' ||
              el.getAttribute('onclick') ||
              el.getAttribute('data-testid') ||
              el.getAttribute('data-cy') ||
              el.getAttribute('data-qa') ||
              el.getAttribute('aria-label')) {
            return el;
          }
          el = el.parentElement;
        }
        return target.closest('svg') || target;
      }

      function getRowScopedSelector(target, directSelector) {
        const containerTags = new Set(['TR', 'LI', 'ARTICLE', 'SECTION']);
        const containerRoles = new Set(['row', 'listitem', 'option', 'treeitem']);

        let ancestor = target.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body && depth < 8) {
          const isContainer =
            containerTags.has(ancestor.tagName) ||
            containerRoles.has(ancestor.getAttribute('role') || '') ||
            ancestor.getAttribute('data-testid') ||
            ancestor.getAttribute('data-row') ||
            ancestor.getAttribute('data-item');

          if (isContainer) {
            const rowText = ancestor.innerText?.trim();
            if (rowText && rowText.length > 0 && rowText.length < 200) {
              const firstLine = rowText.split('\\n')[0]?.trim().substring(0, 60);
              if (firstLine && firstLine.length > 1) {
                const ancestorTag = ancestor.tagName.toLowerCase();
                const ancestorTestId = ancestor.getAttribute('data-testid');
                const ancestorPrefix = ancestorTestId
                  ? '[data-testid="' + ancestorTestId + '"]'
                  : ancestorTag + ':has-text("' + firstLine.replace(/"/g, '\\\\"') + '")';
                return ancestorPrefix + ' >> ' + directSelector;
              }
            }
          }
          ancestor = ancestor.parentElement;
          depth++;
        }
        return null;
      }

      function getBestSelector(originalTarget) {
        if (!originalTarget) return '';
        const target = resolveInteractiveTarget(originalTarget);

        const testId = target.getAttribute('data-testid');
        if (testId) return '[data-testid="' + testId + '"]';
        const dataCy = target.getAttribute('data-cy');
        if (dataCy) return '[data-cy="' + dataCy + '"]';
        const dataQa = target.getAttribute('data-qa');
        if (dataQa) return '[data-qa="' + dataQa + '"]';

        const ariaLabel = target.getAttribute('aria-label');
        if (ariaLabel) {
          const matches = document.querySelectorAll('[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]');
          if (matches.length === 1) return '[aria-label="' + ariaLabel + '"]';
          const scoped = getRowScopedSelector(target, '[aria-label="' + ariaLabel + '"]');
          if (scoped) return scoped;
          return '[aria-label="' + ariaLabel + '"]';
        }
        const role = target.getAttribute('role');
        if (role) {
          const accName = target.getAttribute('aria-label') || target.name || target.innerText?.trim().substring(0, 40);
          if (accName) {
            const roleSel = '[role="' + role + '"][name="' + accName.replace(/"/g, '\\\\"') + '"]';
            return roleSel;
          }
          return '[role="' + role + '"]';
        }

        if (target.id && isSemanticId(target.id)) {
          return '#' + CSS.escape(target.id);
        }

        if (target.name) return '[name="' + target.name + '"]';

        const text = target.innerText?.trim().substring(0, 50);
        if (text && text.length > 0 && text.length <= 50) {
          const matches = document.querySelectorAll('*');
          let exactMatches = 0;
          for (const m of matches) {
            if (m.innerText?.trim() === text) exactMatches++;
            if (exactMatches > 1) break;
          }
          const textSel = 'text="' + text.replace(/"/g, '\\\\"') + '"';
          if (exactMatches > 1) {
            const scoped = getRowScopedSelector(target, textSel);
            if (scoped) return scoped;
          }
          return textSel;
        }

        const tag = target.tagName.toLowerCase();
        let attrSel = null;
        if (target.type) attrSel = tag + '[type="' + target.type + '"]';
        else if (target.placeholder) attrSel = tag + '[placeholder="' + target.placeholder + '"]';
        else {
          const href = target.getAttribute('href');
          if (href && !href.startsWith('data:') && href.length < 100) attrSel = tag + '[href="' + href + '"]';
          const title = target.getAttribute('title');
          if (!attrSel && title) attrSel = tag + '[title="' + title + '"]';
          const alt = target.getAttribute('alt');
          if (!attrSel && alt) attrSel = tag + '[alt="' + alt + '"]';
        }

        if (attrSel) {
          const matches = document.querySelectorAll(attrSel);
          if (matches.length > 1) {
            const scoped = getRowScopedSelector(target, attrSel);
            if (scoped) return scoped;
          }
          return attrSel;
        }

        const scoped = getRowScopedSelector(target, tag);
        if (scoped) return scoped;
        return tag;
      }

      function __buildFingerprint(target){
        const interactive = resolveInteractiveTarget(target);
        const norm = interactive.closest('button,a,[role=button],[role=link],[role=menuitem],input,select,textarea,[tabindex]') || interactive;
        const container = __containerOf(norm);
        const fp = {
          tagName: norm.tagName,
          role: __computedRole(norm),
          accessibleName: __accName(norm),
          visibleText: (norm.innerText||'').trim().slice(0,80),
          iconClass: __detectIcon(norm),
          testId: norm.getAttribute('data-testid') || undefined,
          dataCy: norm.getAttribute('data-cy') || undefined,
          dataQa: norm.getAttribute('data-qa') || undefined,
          ariaLabel: norm.getAttribute('aria-label') || undefined,
          name: norm.getAttribute('name') || undefined,
          href: norm.getAttribute('href') || undefined,
          placeholder: norm.getAttribute('placeholder') || undefined,
          containerRole: container ? (__computedRole(container) || container.tagName.toLowerCase()) : undefined,
          containerKeyText: __keyText(container),
          ancestorRoles: __ancestorRoles(norm),
        };
        return {
          ...fp,
          fingerprint: fp,
          id: norm.id || '',
          className: typeof norm.className === 'string' ? norm.className : '',
          text: (norm.innerText || '').trim().slice(0, 50),
          dataTestId: norm.getAttribute('data-testid') || '',
          xpath: __xpath(norm),
        };
      }

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
          if (fp.dataCy && el.getAttribute('data-cy')===fp.dataCy) s += 95;
          if (fp.dataQa && el.getAttribute('data-qa')===fp.dataQa) s += 90;
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
        best.setAttribute('data-qaforge-target', '1');
        return { score: bestScore, tag: best.tagName, text: (best.innerText||'').slice(0,40) };
      };

      // ---- Hover & Click Listeners for Inspect/Interact Modes ----
      let highlightedElement = null;
      document.addEventListener('mouseover', (e) => {
        if (window.__qaforgeMode !== 'inspect') return;
        if (highlightedElement) highlightedElement.classList.remove('qaforge-highlight');
        highlightedElement = e.target; highlightedElement.classList.add('qaforge-highlight');
      }, true);
      document.addEventListener('mouseout', () => { if (highlightedElement) { highlightedElement.classList.remove('qaforge-highlight'); highlightedElement = null; } }, true);

      let __lastKnownUrl = window.location.href;

      document.addEventListener('click', (e) => {
        if (window.__qaforgeMode === 'inspect') {
          e.preventDefault(); e.stopPropagation();
          try { window.onElementSelected(__buildFingerprint(e.target)); }
          catch (err) { console.error('qaforge fingerprint', err); }
        } else {
          const target = resolveInteractiveTarget(e.target);
          if (target.tagName === 'HTML' || target.tagName === 'BODY') return;
          const selector = getBestSelector(target);

          window.onInteractionRecorded({
            kind: 'click',
            selector: selector,
            value: target.innerText?.substring(0, 50) || '',
            fingerprint: __buildFingerprint(target).fingerprint
          });

          __lastKnownUrl = window.location.href;
          setTimeout(() => {
            if (window.location.href !== __lastKnownUrl) {
              __lastKnownUrl = window.location.href;
            }
          }, 1500);
        }
      }, true);

      // Debounced input recording
      const __inputTimers = new WeakMap();
      document.addEventListener('input', (e) => {
        if (window.__qaforgeMode === 'inspect') return;
        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
          const prevTimer = __inputTimers.get(target);
          if (prevTimer) clearTimeout(prevTimer);

          const timer = setTimeout(() => {
            if (target.__lastRecordedValue === target.value) return;
            target.__lastRecordedValue = target.value;
            const selector = getBestSelector(target);
            window.onInteractionRecorded({
              kind: 'input',
              selector: selector,
              value: target.value,
              fingerprint: __buildFingerprint(target).fingerprint
            });
          }, 500);
          __inputTimers.set(target, timer);
        }
      }, true);

      document.addEventListener('change', (e) => {
        if (window.__qaforgeMode === 'inspect') return;
        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
          const prevTimer = __inputTimers.get(target);
          if (prevTimer) clearTimeout(prevTimer);

          if (target.__lastRecordedValue === target.value) return;
          target.__lastRecordedValue = target.value;
          const selector = getBestSelector(target);
          window.onInteractionRecorded({
            kind: 'input',
            selector: selector,
            value: target.value,
            fingerprint: __buildFingerprint(target).fingerprint
          });
        }
      }, true);

      document.addEventListener('keydown', (e) => {
        if (window.__qaforgeMode === 'inspect') return;
        const target = e.target;
        if (e.key === 'Enter' && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          const prevTimer = __inputTimers.get(target);
          if (prevTimer) clearTimeout(prevTimer);

          if (target.__lastRecordedValue !== target.value) {
            target.__lastRecordedValue = target.value;
            const selector = getBestSelector(target);
            window.onInteractionRecorded({
              kind: 'input',
              selector: selector,
              value: target.value,
              fingerprint: __buildFingerprint(target).fingerprint
            });
          }
          const selector = getBestSelector(target);
          window.onInteractionRecorded({
            kind: 'press',
            selector: selector,
            value: 'Enter',
            fingerprint: __buildFingerprint(target).fingerprint
          });
        }
      }, true);

      let scrollTimeout;
      window.addEventListener('scroll', () => {
        if (window.__qaforgeMode === 'inspect') return;
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          window.onInteractionRecorded({
            kind: 'scroll',
            value: window.scrollY.toString()
          });
        }, 800);
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
    try { if (cdpClient) { await cdpClient.detach().catch(() => { }); cdpClient = null; } } catch { }
    if (page) { await page.close().catch(() => { }); page = null; }
    if (context) { await context.close().catch(() => { }); context = null; }
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

  async function ensureResolverHelpers(p) {
    const has = await p.evaluate(() => typeof window.__qaforgeResolve === 'function').catch(() => false);
    if (has) return;
    await injectInspector(p);
  }

  async function resolveFingerprint(p, fp) {
    await ensureResolverHelpers(p);
    await p.evaluate(() => document.querySelectorAll('[data-qaforge-target]').forEach(e => e.removeAttribute('data-qaforge-target')));
    const res = await p.evaluate((f) => window.__qaforgeResolve(f), fp);
    if (!res) return null;
    return p.locator('[data-qaforge-target="1"]').first();
  }

  socket.on('run_flow', async ({ url, steps, slowMo = 800 }) => {
    let runPage = null;
    let runContext = null;
    let runCdpClient = null;

    const emitLog = (level, message) => {
      socket.emit('run_log', { timestamp: new Date().toISOString(), level, message });
    };

    // Stability helper
    async function waitForPageStability(pg, timeoutMs = 10000) {
      const start = Date.now();
      emitLog('info', '⌛ Waiting for page stability (network, DOM, loaders)…');
      try {
        await pg.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
      } catch { }
      try {
        const isStable = await pg.evaluate(async (timeout) => {
          return new Promise((resolve) => {
            let lastMutation = Date.now();
            const observer = new MutationObserver(() => { lastMutation = Date.now(); });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
            const checkInterval = setInterval(() => {
              const now = Date.now();
              const loaderSelectors = ['[class*="spinner"]', '[class*="loader"]', '[class*="loading"]', '[id*="loading"]', '[role="progressbar"]', '[class*="shimmer"]', '[class*="backdrop"]'];
              let hasActiveLoader = false;
              for (const sel of loaderSelectors) {
                try {
                  const loaders = Array.from(document.querySelectorAll(sel));
                  const visibleLoaders = loaders.filter(el => {
                    const style = window.getComputedStyle(el);
                    const isRealSpinner = /spinner|loader|loading|shimmer/i.test(el.className + ' ' + el.id) || el.getAttribute('role') === 'progressbar';
                    return isRealSpinner && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0 && el.offsetWidth > 5 && el.offsetHeight > 5;
                  });
                  if (visibleLoaders.length > 0) { hasActiveLoader = true; break; }
                } catch { }
              }
              const timeSinceLastMutation = now - lastMutation;
              if (timeSinceLastMutation >= 400 && !hasActiveLoader) { cleanup(); resolve(true); }
              else if (now - start > timeout) { cleanup(); resolve(false); }
            }, 100);
            const start = Date.now();
            function cleanup() { observer.disconnect(); clearInterval(checkInterval); }
          });
        }, timeoutMs);
        if (isStable) emitLog('info', '✓ Page is stable');
        else emitLog('warn', '⚠ Page stability timeout reached, proceeding anyway');
      } catch (e) {
        await pg.waitForTimeout(600);
      }
    }

    // Blocker resolution helpers using locators
    async function checkLocatorBlocker(locator) {
      try {
        const isVisible = await locator.isVisible();
        if (!isVisible) return { blocked: false, reason: 'invisible' };
        return await locator.evaluate((el) => {
          if (!el) return { blocked: false };
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return { blocked: true, reason: 'zero_size' };
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return { blocked: false, reason: 'outside_viewport' };
          const topEl = document.elementFromPoint(x, y);
          if (!topEl) return { blocked: false, reason: 'no_element_at_point' };
          let isDescendantOrSelf = el.contains(topEl) || el === topEl;
          let isAncestor = topEl.contains(el);
          if (isDescendantOrSelf || isAncestor) return { blocked: false };
          let parent = el.parentElement;
          while (parent) { if (parent === topEl) return { blocked: false }; parent = parent.parentElement; }
          return { blocked: true, tag: topEl.tagName, classes: topEl.className?.substring?.(0, 100) || '', id: topEl.id || '', role: topEl.getAttribute('role') || '', text: topEl.innerText?.substring?.(0, 50) || '' };
        });
      } catch (e) {
        return { blocked: false, error: e.message };
      }
    }

    async function dismissBlockingOverlayForLocator(pg, blockerInfo) {
      emitLog('info', `🍪 Attempting to dismiss blocking overlay: <${blockerInfo.tag} class="${blockerInfo.classes}">…`);
      try {
        const result = await pg.evaluate(({ blockerTag, blockerId, blockerClass }) => {
          let blocker = null;
          if (blockerId) blocker = document.getElementById(blockerId);
          if (!blocker && blockerClass) {
            const selector = `${blockerTag}.${blockerClass.split(' ').filter(c => c.trim()).join('.')}`;
            try { blocker = document.querySelector(selector); } catch { }
          }
          if (!blocker) blocker = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
          if (!blocker) return { success: false, reason: 'blocker_not_found_in_dom' };
          const text = blocker.innerText || '';
          const isCookie = /cookie|consent|gdpr|privacy/i.test(blocker.className + ' ' + blocker.id + ' ' + text);
          const isModal = /modal|dialog|popup|overlay/i.test(blocker.className + ' ' + blocker.id + ' ' + blocker.getAttribute('role'));
          if (!isCookie && !isModal) return { success: false, reason: 'blocker_is_not_cookie_or_modal' };
          const buttons = Array.from(blocker.querySelectorAll('button, a, [role="button"]'));
          const acceptPatterns = [/accept\s*all/i, /accept\s*cookies/i, /allow\s*all/i, /agree/i, /i\s*agree/i, /accept/i, /ok/i, /continue/i];
          const dismissPatterns = [/close/i, /dismiss/i, /no\s*thanks/i, /maybe\s*later/i];
          if (isCookie) {
            for (const pattern of acceptPatterns) {
              const btn = buttons.find(b => pattern.test(b.innerText || b.getAttribute('aria-label') || ''));
              if (btn) { btn.click(); return { success: true, clicked: btn.innerText || btn.tagName, type: 'cookie' }; }
            }
          }
          for (const pattern of dismissPatterns) {
            const btn = buttons.find(b => pattern.test(b.innerText || b.getAttribute('aria-label') || ''));
            if (btn) { btn.click(); return { success: true, clicked: btn.innerText || btn.tagName, type: 'dismiss' }; }
          }
          for (const pattern of acceptPatterns) {
            const btn = buttons.find(b => pattern.test(b.innerText || b.getAttribute('aria-label') || ''));
            if (btn) { btn.click(); return { success: true, clicked: btn.innerText || btn.tagName, type: 'accept_fallback' }; }
          }
          const closeIconBtn = buttons.find(b => {
            const cls = b.className || '';
            const label = b.getAttribute('aria-label') || '';
            return /close|btn-close|modal__close/i.test(cls) || /close/i.test(label) || (b.innerText?.trim() === '×');
          });
          if (closeIconBtn) { closeIconBtn.click(); return { success: true, clicked: 'close_icon', type: 'close_icon' }; }
          return { success: false, reason: 'no_matching_button_found_inside_blocker' };
        }, { blockerTag: blockerInfo.tag, blockerId: blockerInfo.id, blockerClass: blockerInfo.classes });

        if (result.success) {
          emitLog('info', `🍪 Scoped auto-dismissed blocker: clicked "${result.clicked}" (${result.type})`);
          socket.emit('popup_dismissed', { type: result.type, button: result.clicked });
          return true;
        } else {
          emitLog('warn', `⚠ Could not auto-dismiss blocker: ${result.reason}`);
          return false;
        }
      } catch (err) {
        emitLog('warn', `⚠ Error trying to dismiss blocker: ${err.message}`);
        return false;
      }
    }

    async function resolveBlockerForLocator(pg, locator, label) {
      await waitForPageStability(pg);
      let blocker = await checkLocatorBlocker(locator);
      if (blocker && blocker.blocked) {
        emitLog('info', `${label} — Target element is blocked by <${blocker.tag} id="${blocker.id}" class="${blocker.classes}">. Resolving…`);
        const isLoader = /spinner|loader|loading|shimmer/i.test(blocker.classes + ' ' + blocker.id) || blocker.role === 'progressbar';
        if (isLoader) {
          emitLog('info', `${label} — Blocker is a loader/spinner. Waiting for it to disappear…`);
          const startWait = Date.now();
          while (Date.now() - startWait < 5000) {
            await pg.waitForTimeout(400);
            blocker = await checkLocatorBlocker(locator);
            if (!blocker || !blocker.blocked) { emitLog('info', `${label} — Loader disappeared.`); break; }
          }
        }
        if (blocker && blocker.blocked) {
          const text = blocker.text || '';
          const isCookie = /cookie|consent|gdpr|privacy/i.test(blocker.classes + ' ' + blocker.id + ' ' + text);
          const isModal = /modal|dialog|popup|overlay/i.test(blocker.classes + ' ' + blocker.id + ' ' + blocker.role);
          if (isCookie || isModal) {
            const dismissed = await dismissBlockingOverlayForLocator(pg, blocker);
            if (dismissed) { await pg.waitForTimeout(500); blocker = await checkLocatorBlocker(locator); }
          }
        }
        if (blocker && blocker.blocked) {
          emitLog('info', `${label} — Still blocked. Waiting up to 3s for blocker to animate/transition out…`);
          const startWait = Date.now();
          while (Date.now() - startWait < 3000) {
            await pg.waitForTimeout(300);
            blocker = await checkLocatorBlocker(locator);
            if (!blocker || !blocker.blocked) { emitLog('info', `${label} — Blocker animated/transitioned out.`); break; }
          }
        }
      }
    }

    // Highlighting using locator context
    async function highlightLocator(locator) {
      try {
        await locator.evaluate((el) => {
          el.style.outline = '3px solid #00ff88';
          el.style.outlineOffset = '2px';
          el.style.boxShadow = '0 0 20px rgba(0,255,136,0.5), 0 0 40px rgba(0,255,136,0.2)';
          el.style.transition = 'outline 0.3s ease, box-shadow 0.3s ease';
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; el.style.boxShadow = ''; }, 1200);
        });
        await locator.page().waitForTimeout(400);
      } catch { }
    }

    async function waitForStableBoundingBox(pg, selector, timeoutMs = 2500) {
      try {
        let loc = selector.includes(' >> ')
          ? selector.split(' >> ').reduce((acc, p) => acc.locator(p), pg).first()
          : pg.locator(selector).first();
        const start = Date.now();
        let prevBox = null;
        let stableCount = 0;
        while (Date.now() - start < timeoutMs) {
          const isVisible = await loc.isVisible().catch(() => false);
          if (!isVisible) { await pg.waitForTimeout(100); continue; }
          const box = await loc.boundingBox().catch(() => null);
          if (box) {
            if (prevBox && Math.abs(box.x - prevBox.x) < 0.5 && Math.abs(box.y - prevBox.y) < 0.5 && Math.abs(box.width - prevBox.width) < 0.5 && Math.abs(box.height - prevBox.height) < 0.5) {
              stableCount++;
              if (stableCount >= 3) return true;
            } else {
              stableCount = 0;
            }
            prevBox = box;
          }
          await pg.waitForTimeout(50);
        }
      } catch { }
      return false;
    }

    async function runLookaheadValidation(pg, nextSelector, label) {
      await waitForPageStability(pg);
      if (nextSelector) {
        emitLog('info', `${label} — Post-action lookahead validation: Waiting for next step's selector "${nextSelector}" to become visible and stable…`);
        try {
          let loc = nextSelector.includes(' >> ')
            ? nextSelector.split(' >> ').reduce((acc, p) => acc.locator(p), pg).first()
            : pg.locator(nextSelector).first();
          await loc.waitFor({ state: 'visible', timeout: 3000 });
          const isStable = await waitForStableBoundingBox(pg, nextSelector, 2000);
          if (isStable) emitLog('info', `${label} — Next step's selector is visible and stable.`);
          else emitLog('info', `${label} — Next step's selector is visible (stabilization timed out).`);
        } catch (e) {
          emitLog('info', `${label} — Lookahead validation finished (next selector not yet visible/stable).`);
        }
      }
    }

    try {
      emitLog('info', `Launching browser… (slowMo: ${slowMo}ms)`);
      await teardown(); // clean up any active session first
      if (!browser) browser = await chromium.launch({ headless: true });
      runContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      runPage = await runContext.newPage();

      runPage.on('dialog', async (dialog) => {
        const type = dialog.type();
        const msg = dialog.message();
        emitLog('info', `🔔 Native dialog detected: [${type}] "${msg}"`);
        socket.emit('popup_detected', { type: 'dialog', dialogType: type, message: msg });
        try {
          if (type === 'prompt') await dialog.accept('');
          else await dialog.accept();
          emitLog('info', `🔔 Native dialog auto-accepted`);
        } catch (e) {
          emitLog('warn', `Could not dismiss dialog: ${e.message}`);
        }
      });

      let currentStepId = null;
      const requestStartTimes = new Map();
      runPage.on('request', (request) => {
        const reqUrl = request.url();
        const resourceType = request.resourceType();
        if ((resourceType === 'fetch' || resourceType === 'xhr') && !reqUrl.includes('/socket.io/') && !reqUrl.includes('localhost:4000')) {
          requestStartTimes.set(request, Date.now());
        }
      });

      runPage.on('response', async (response) => {
        const request = response.request();
        if (requestStartTimes.has(request)) {
          const startTime = requestStartTimes.get(request);
          const durationMs = Date.now() - startTime;
          requestStartTimes.delete(request);
          const reqUrl = response.url();
          const method = request.method();
          const status = response.status();
          let payload = request.postData() || undefined;
          let responseText = undefined;
          try { responseText = await response.text(); } catch { }
          const apiCall = {
            id: Math.random().toString(36).substring(2, 9),
            method,
            url: reqUrl,
            status,
            durationMs,
            triggeredByStepId: currentStepId,
            payload: payload ? payload.substring(0, 1000) : undefined,
            response: responseText ? responseText.substring(0, 1000) : undefined
          };
          socket.emit('api_call_captured', apiCall);
        }
      });

      try {
        runCdpClient = await runContext.newCDPSession(runPage);
        await runCdpClient.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 1, maxWidth: 1280, maxHeight: 800 });
        runCdpClient.on('Page.screencastFrame', async (frame) => {
          socket.emit('screencast_frame', { data: frame.data });
          try { await runCdpClient.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch { }
        });
        emitLog('info', 'Screencast started');
      } catch (cdpErr) {
        emitLog('warn', 'Screencast unavailable: ' + cdpErr.message);
      }

      socket.emit('run_started', { url });
      emitLog('info', `Navigating to ${url}`);
      await runPage.goto(url, { waitUntil: 'load', timeout: 30000 });
      await waitForPageStability(runPage);

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        currentStepId = step.id;
        const label = `Step ${i + 1}/${steps.length} [${step.kind}]`;
        socket.emit('step_running', { stepId: step.id });
        emitLog('info', `${label} — running${step.selector ? ` → ${step.selector}` : ''}${step.value ? ` value="${step.value}"` : ''}`);

        let nextStepSelector = null;
        if (i + 1 < steps.length) {
          const nextStep = steps[i + 1];
          if (nextStep.selector) nextStepSelector = escapeCssSelector(nextStep.selector);
        }

        if (slowMo > 0 && i > 0) {
          await runPage.waitForTimeout(slowMo);
        }

        try {
          if (step.kind === 'navigate') {
            const targetUrl = step.value || url;
            let alreadyNavigated = false;
            try {
              await runPage.waitForURL((urlObj) => {
                const normCurrent = urlObj.toString().toLowerCase().replace(/\/$/, '').split('?')[0];
                const normTarget = targetUrl.toLowerCase().replace(/\/$/, '').split('?')[0];
                return normCurrent === normTarget || normCurrent.endsWith(normTarget) || normTarget.endsWith(normCurrent);
              }, { timeout: 3000 });
              alreadyNavigated = true;
              emitLog('info', `${label} — Already at target URL or navigated naturally. Skipping hard reload.`);
            } catch { }
            if (!alreadyNavigated) {
              emitLog('info', `${label} — Performing hard navigation to ${targetUrl}`);
              await runPage.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
            }
            await waitForPageStability(runPage);

          } else if (step.kind === 'wait') {
            const ms = parseInt(step.value || '1000');
            emitLog('info', `${label} — waiting ${ms}ms`);
            await runPage.waitForTimeout(ms);

          } else if (step.kind === 'click') {
            let locator = null;
            let clicked = false;
            let lastError = null;

            if (step.fingerprint) {
              emitLog('info', `${label} — Resolving fingerprint: ${JSON.stringify(step.fingerprint)}`);
              locator = await resolveFingerprint(runPage, step.fingerprint);
            }
            if (!locator && step.selector) {
              if (step.selector.includes(' >> ')) {
                locator = step.selector.split(' >> ').reduce((acc, p) => acc.locator(p), runPage).first();
              } else {
                locator = runPage.locator(escapeCssSelector(step.selector)).first();
              }
            }

            if (locator) {
              await resolveBlockerForLocator(runPage, locator, label);
              await highlightLocator(locator);
              try {
                await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
                await locator.click({ timeout: 4000 });
                clicked = true;
              } catch (clickErr) {
                lastError = clickErr;
                emitLog('warn', `${label} — Click failed: ${clickErr.message}`);

                // AI healing (from remote branch)
                socket.emit('step_healing', { stepId: step.id, fingerprint: step.fingerprint, selector: step.selector });
                const apiKey = process.env.GEMINI_API_KEY;
                if (apiKey && apiKey.startsWith('gsk_')) {
                  emitLog('info', `${label} — Triggering AI healing…`);
                  try {
                    const snapshot = await runPage.evaluate(() => {
                      const rows = [];
                      document.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],input,select,textarea').forEach((el, i) => {
                        if (i > 200) return;
                        const r = el.getBoundingClientRect();
                        if (r.width < 2 || r.height < 2) return;
                        rows.push({
                          tag: el.tagName,
                          role: el.getAttribute('role') || null,
                          name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().slice(0, 60),
                          testId: el.getAttribute('data-testid') || null,
                          href: el.getAttribute('href') || null,
                          placeholder: el.getAttribute('placeholder') || null,
                        });
                      });
                      return rows;
                    });
                    const prompt = `Original target fingerprint:\n${JSON.stringify(step.fingerprint || { selector: step.selector }, null, 2)}\n\nVisible actionable elements on the page (JSON):\n${JSON.stringify(snapshot).slice(0, 12000)}\n\nReturn ONLY a JSON object matching this shape (fields optional, omit unknown): {"role":"","accessibleName":"","iconClass":"","testId":"","ariaLabel":"","visibleText":"","tagName":"","containerKeyText":""}. No prose, no code fences.`;
                    const groq = new Groq({ apiKey });
                    const r = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } });
                    const healed = JSON.parse(r.choices?.[0]?.message?.content || '{}');
                    socket.emit('step_healed', { stepId: step.id, fingerprint: healed });
                    const healedLoc = await resolveFingerprint(runPage, healed);
                    if (healedLoc) {
                      await resolveBlockerForLocator(runPage, healedLoc, label);
                      await highlightLocator(healedLoc);
                      await healedLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
                      await healedLoc.click({ timeout: 4000 });
                      clicked = true;
                    }
                  } catch (healErr) {
                    emitLog('warn', `${label} — AI healing failed: ${healErr.message}`);
                  }
                }
              }
            }

            // Fallback for text selectors if the primary selector failed
            if (!clicked && step.selector && step.selector.startsWith('text=')) {
              let rawText = step.selector.slice(5);
              if (rawText.startsWith('"') && rawText.endsWith('"')) rawText = rawText.slice(1, -1);
              rawText = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
              const fallbacks = [
                { type: 'button role', selector: `role=button[name="${rawText.replace(/"/g, '\\"')}"i]`, timeout: 3000 },
                { type: 'button text', selector: `button:has-text("${rawText.replace(/"/g, '\\"')}")`, timeout: 3000 },
                { type: 'button role text', selector: `[role="button"]:has-text("${rawText.replace(/"/g, '\\"')}")`, timeout: 3000 },
                { type: 'link role', selector: `role=link[name="${rawText.replace(/"/g, '\\"')}"i]`, timeout: 3000 },
                { type: 'link text', selector: `a:has-text("${rawText.replace(/"/g, '\\"')}")`, timeout: 3000 },
                { type: 'input submit', selector: `input[type="submit"][value="${rawText.replace(/"/g, '\\"')}" i]`, timeout: 2500 },
                { type: 'input button', selector: `input[type="button"][value="${rawText.replace(/"/g, '\\"')}" i]`, timeout: 2500 },
                { type: 'case-insensitive substring', selector: `text=${rawText}`, timeout: 2000 },
                { type: 'generic containing text', selector: `*:has-text("${rawText.replace(/"/g, '\\"')}")`, timeout: 2000 }
              ];
              for (const fb of fallbacks) {
                try {
                  emitLog('info', `${label} — Trying fallback (${fb.type}): ${fb.selector}`);
                  const fbLoc = runPage.locator(fb.selector).first();
                  await fbLoc.waitFor({ state: 'visible', timeout: fb.timeout });
                  await resolveBlockerForLocator(runPage, fbLoc, label);
                  await highlightLocator(fbLoc);
                  await fbLoc.click({ timeout: fb.timeout });
                  clicked = true;
                  emitLog('info', `${label} — Clicked successfully using fallback: ${fb.selector}`);
                  break;
                } catch { }
              }
            }

            if (!clicked) throw lastError || new Error(`Failed to click selector: ${step.selector}`);
            await runLookaheadValidation(runPage, nextStepSelector, label);

          } else if (step.kind === 'input') {
            let locator = null;
            if (step.fingerprint) locator = await resolveFingerprint(runPage, step.fingerprint);
            if (!locator && step.selector) {
              if (step.selector.includes(' >> ')) {
                locator = step.selector.split(' >> ').reduce((acc, p) => acc.locator(p), runPage).first();
              } else {
                locator = runPage.locator(escapeCssSelector(step.selector)).first();
              }
            }
            if (!locator) throw new Error('No fingerprint or selector for input step');
            await resolveBlockerForLocator(runPage, locator, label);
            await highlightLocator(locator);
            try {
              await locator.fill('');
              if (step.value) await locator.pressSequentially(step.value, { delay: 40, timeout: 5000 });
            } catch (err) {
              await locator.fill(step.value || '', { timeout: 5000 });
            }
            await runLookaheadValidation(runPage, nextStepSelector, label);

          } else if (step.kind === 'press') {
            let locator = null;
            if (step.fingerprint) locator = await resolveFingerprint(runPage, step.fingerprint);
            if (!locator && step.selector) {
              if (step.selector.includes(' >> ')) {
                locator = step.selector.split(' >> ').reduce((acc, p) => acc.locator(p), runPage).first();
              } else {
                locator = runPage.locator(escapeCssSelector(step.selector)).first();
              }
            }
            if (!locator) throw new Error('No fingerprint or selector for press step');
            await resolveBlockerForLocator(runPage, locator, label);
            await highlightLocator(locator);
            emitLog('info', `${label} — pressing key "${step.value || 'Enter'}"`);
            await locator.press(step.value || 'Enter', { timeout: 5000 });
            await runLookaheadValidation(runPage, nextStepSelector, label);

          } else if (step.kind === 'scroll') {
            await runPage.evaluate((val) => window.scrollBy(0, parseInt(val || '300')), step.value);
            await runPage.waitForTimeout(300);

          } else if (step.kind === 'assert') {
            let locator = null;
            if (step.fingerprint) locator = await resolveFingerprint(runPage, step.fingerprint);
            if (!locator && step.selector) {
              if (step.selector.includes(' >> ')) {
                locator = step.selector.split(' >> ').reduce((acc, p) => acc.locator(p), runPage).first();
              } else {
                locator = runPage.locator(escapeCssSelector(step.selector)).first();
              }
            }
            if (!locator) throw new Error(`Assertion failed: element "${step.selector || 'fingerprint'}" not found`);
            await highlightLocator(locator);
            await locator.waitFor({ state: 'visible', timeout: 8000 });
          }

          emitLog('pass', `${label} — passed ✓`);
          socket.emit('step_completed', { stepId: step.id, status: 'pass' });
        } catch (error) {
          console.error(`Step failed: ${step.id}`, error);
          emitLog('fail', `${label} — FAILED: ${error.message}`);
          socket.emit('step_completed', { stepId: step.id, status: 'fail', error: error.message });
          break;
        }
      }

      emitLog('info', 'Waiting for final page redirects/settling…');
      await runPage.waitForLoadState('networkidle').catch(() => { });
      await runPage.waitForTimeout(3000);
      emitLog('info', 'Run finished');
      socket.emit('run_finished', { success: true });
    } catch (error) {
      console.error(error);
      emitLog('fail', 'Run error: ' + error.message);
      socket.emit('run_finished', { success: false, error: error.message });
    } finally {
      if (runCdpClient) try { await runCdpClient.detach().catch(() => { }); } catch { }
      if (runPage) await runPage.close().catch(() => { });
      if (runContext) await runContext.close().catch(() => { });
    }
  });

  socket.on('set_mode', async ({ mode }) => {
    if (!page) return;
    try { await page.evaluate((m) => { window.__qaforgeMode = m; }, mode); } catch { }
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
  socket.on('forward_move', async ({ x, y }) => { if (!page) return; try { await page.mouse.move(Math.round(x), Math.round(y)); } catch { } });
  socket.on('forward_key', async ({ key }) => { if (!page) return; try { await page.keyboard.press(key); } catch (e) { console.error('forward_key', e.message); } });
  socket.on('forward_type', async ({ text }) => { if (!page) return; try { await page.keyboard.type(text); } catch (e) { console.error('forward_type', e.message); } });

  socket.on('stop_session', async () => { await teardown(); socket.emit('session_stopped'); });
  socket.on('disconnect', async () => { console.log('Client disconnected:', socket.id); await teardown(); });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`Automation Server running on port ${PORT}`));
