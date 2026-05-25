import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { chromium } from 'playwright';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { Groq } from 'groq-sdk';

dotenv.config();
// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

// API Tester Proxy Endpoint
app.post('/proxy', async (req, res) => {
  const { url, method, headers, data } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const startTime = Date.now();
  try {
    const response = await axios({
      url,
      method: method || 'GET',
      headers: headers || {},
      data,
      validateStatus: () => true, // Don't throw on 4xx/5xx
      timeout: 15000
    });

    res.json({
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      timeMs: Date.now() - startTime,
      size: JSON.stringify(response.data)?.length || 0
    });
  } catch (error) {
    res.json({
      status: 0,
      statusText: 'Error',
      error: error.message,
      timeMs: Date.now() - startTime,
      size: 0
    });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

let browser;
let context;
let page;

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  const VIEWPORT = { width: 1280, height: 800 };
  let cdpClient = null;

  socket.on('start_session', async ({ url }) => {
    try {
      if (!browser) {
        browser = await chromium.launch({ headless: true });
      }
      context = await browser.newContext({ viewport: VIEWPORT });
      page = await context.newPage();
      socket.emit('viewport_info', VIEWPORT);

      // Setup page listeners for network and DOM events
      page.on('dialog', async (dialog) => {
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

      page.on('request', request => {
        socket.emit('network_request', {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
        });
      });

      page.on('response', async response => {
        try {
          const request = response.request();
          const headers = response.headers();
          const url = response.url();

          // Security Checks
          const issues = [];

          // 1. Missing Security Headers
          if (!headers['strict-transport-security'] && url.startsWith('https://')) {
            issues.push({ type: 'header', name: 'Missing HSTS', severity: 'Medium', details: 'Strict-Transport-Security header is missing.' });
          }
          if (!headers['x-frame-options'] && !headers['content-security-policy']?.includes('frame-ancestors')) {
            issues.push({ type: 'header', name: 'Missing Clickjacking Protection', severity: 'Medium', details: 'X-Frame-Options or CSP frame-ancestors is missing.' });
          }

          // 2. Insecure Cookies
          const setCookie = headers['set-cookie'];
          if (setCookie) {
            const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
            cookies.forEach(c => {
              if (!c.toLowerCase().includes('secure')) {
                issues.push({ type: 'cookie', name: 'Insecure Cookie', severity: 'High', details: 'Cookie is missing the Secure flag.' });
              }
              if (!c.toLowerCase().includes('httponly') && (c.toLowerCase().includes('session') || c.toLowerCase().includes('token'))) {
                issues.push({ type: 'cookie', name: 'Missing HttpOnly on Auth Cookie', severity: 'High', details: 'Potentially sensitive cookie missing HttpOnly flag.' });
              }
            });
          }

          // 3. Exposed Tokens (Naive check in response body for demo)
          let body = null;
          if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') {
            body = await response.text().catch(() => null);
            if (body) {
              if (/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(body) && !url.includes('auth') && !url.includes('login')) {
                issues.push({ type: 'leak', name: 'Exposed JWT Token', severity: 'Critical', details: 'Found a JWT token in the response body of a non-auth endpoint.' });
              }
            }
          }

          if (issues.length > 0) {
            socket.emit('security_issues', { url, issues });
          }

          if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') {
            socket.emit('network_response', {
              url: response.url(),
              status: response.status(),
              ok: response.ok(),
              body: body ? body.substring(0, 1000) : null
            });
          }
        } catch (error) {
          console.error('Error capturing response:', error);
        }
      });

      await page.exposeFunction('onElementSelected', (elData) => {
        socket.emit('element_selected', elData);
      });

      await page.exposeFunction('onInteractionRecorded', (data) => {
        socket.emit('interaction_recorded', data);
      });

      let isInitialNavigation = true;
      page.on('framenavigated', async (frame) => {
        if (frame === page.mainFrame()) {
          const url = frame.url();
          if (url && url !== 'about:blank') {
            if (isInitialNavigation) {
              isInitialNavigation = false;
              return;
            }
            // Wait for the new page to finish loading before emitting the navigate step
            try {
              await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
              // Small settle time for dynamic content
              await page.waitForTimeout(500);
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

      await page.goto(url, { waitUntil: 'domcontentloaded' });

      // Inject CSS for highlighting
      await page.addStyleTag({
        content: `
        .qaforge-highlight {
          outline: 2px dashed #ff00ff !important;
          background-color: rgba(255, 0, 255, 0.1) !important;
          cursor: crosshair !important;
        }
      `});

      // Inject JS for element selection and interaction recording (toggle via window.__qaforgeMode)
      await page.addScriptTag({
        content: `
        window.__qaforgeMode = 'interact';
        let highlightedElement = null;

        document.addEventListener('mouseover', (e) => {
          if (window.__qaforgeMode !== 'inspect') return;
          if (highlightedElement) highlightedElement.classList.remove('qaforge-highlight');
          highlightedElement = e.target;
          highlightedElement.classList.add('qaforge-highlight');
        }, true);

        document.addEventListener('mouseout', (e) => {
          if (highlightedElement) {
            highlightedElement.classList.remove('qaforge-highlight');
            highlightedElement = null;
          }
        }, true);

        function getXPath(element) {
          if (element.id !== '') return 'id("' + element.id + '")';
          if (element === document.body) return element.tagName;
          let ix = 0;
          let siblings = element.parentNode.childNodes;
          for (let i = 0; i < siblings.length; i++) {
            let sibling = siblings[i];
            if (sibling === element) return getXPath(element.parentNode) + '/' + element.tagName + '[' + (ix + 1) + ']';
            if (sibling.nodeType === 1 && sibling.tagName === element.tagName) ix++;
          }
        }

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

        // === SVG-aware target resolution ===
        // When user clicks an SVG/path/circle/line/polyline, bubble up to nearest
        // interactive ancestor (button, a, [role=button]) for more stable selectors.
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
          // If no interactive ancestor found, return the original SVG element
          return target.closest('svg') || target;
        }

        // === Row-scoped selector: find contextual ancestor for repeated elements ===
        // Walks up DOM to find a row/item ancestor (tr, li, [role=row], etc.)
        // that has unique text content, then composes a Playwright chained selector
        // e.g. tr:has-text("Darshan") >> [aria-label="Edit"]
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
              // Get unique text from this row/container
              const rowText = ancestor.innerText?.trim();
              if (rowText && rowText.length > 0 && rowText.length < 200) {
                // Take first meaningful text line (avoid grabbing the entire row innerHTML)
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
          return null; // No row context found
        }

        // Selector priority: data-testid/cy/qa → aria-label/role → semantic id → name → text → CSS attr → tag
        // For SVG/repeated elements: first tries direct selector, then row-scoped fallback
        // NEVER: class names, nth-child, deep DOM path, positional XPath
        function getBestSelector(originalTarget) {
          if (!originalTarget) return '';

          // Resolve SVG children to their interactive parent
          const target = resolveInteractiveTarget(originalTarget);

          // 1st: data-testid, data-cy, data-qa (globally unique — no scoping needed)
          const testId = target.getAttribute('data-testid');
          if (testId) return '[data-testid="' + testId + '"]';
          const dataCy = target.getAttribute('data-cy');
          if (dataCy) return '[data-cy="' + dataCy + '"]';
          const dataQa = target.getAttribute('data-qa');
          if (dataQa) return '[data-qa="' + dataQa + '"]';

          // 2nd: aria-label, role + accessible name
          const ariaLabel = target.getAttribute('aria-label');
          if (ariaLabel) {
            // Check if this aria-label is unique on the page
            const matches = document.querySelectorAll('[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]');
            if (matches.length === 1) return '[aria-label="' + ariaLabel + '"]';
            // Not unique — try row-scoped
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

          // 3rd: id — only if semantic (not auto-generated)
          if (target.id && isSemanticId(target.id)) {
            return '#' + CSS.escape(target.id);
          }

          // 4th: name attribute — reliable for form fields
          if (target.name) return '[name="' + target.name + '"]';

          // 5th: visible text content — good fallback
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

          // 6th: short CSS attribute path — only if nothing above exists
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
            // Check uniqueness, try row-scoped if duplicated
            const matches = document.querySelectorAll(attrSel);
            if (matches.length > 1) {
              const scoped = getRowScopedSelector(target, attrSel);
              if (scoped) return scoped;
            }
            return attrSel;
          }

          // Last resort: tag name with row scoping
          const scoped = getRowScopedSelector(target, tag);
          if (scoped) return scoped;
          return tag;
        }

        // Track the current URL so we can detect navigation after clicks
        let __lastKnownUrl = window.location.href;

        document.addEventListener('click', (e) => {
          if (window.__qaforgeMode === 'inspect') {
            e.preventDefault();
            e.stopPropagation();
            // Resolve SVG children to their interactive parent for better selectors
            const target = resolveInteractiveTarget(e.target);
            const elData = {
              tagName: target.tagName,
              id: target.id,
              className: typeof target.className === 'string' ? target.className : '',
              text: target.innerText?.substring(0, 50),
              placeholder: target.placeholder,
              name: target.name,
              type: target.type || null,
              href: target.getAttribute('href') || null,
              title: target.getAttribute('title') || null,
              alt: target.getAttribute('alt') || null,
              role: target.getAttribute('role'),
              ariaLabel: target.getAttribute('aria-label'),
              dataTestId: target.getAttribute('data-testid'),
              dataCy: target.getAttribute('data-cy'),
              dataQa: target.getAttribute('data-qa'),
              xpath: getXPath(target)
            };
            window.onElementSelected(elData);
          } else {
            const target = resolveInteractiveTarget(e.target);
            if (target.tagName === 'HTML' || target.tagName === 'BODY') return;
            const selector = getBestSelector(target);

            // Record the click
            window.onInteractionRecorded({
              kind: 'click',
              selector: selector,
              value: target.innerText?.substring(0, 50) || ''
            });

            // After a click, check if the page navigates (with a short delay)
            __lastKnownUrl = window.location.href;
            setTimeout(() => {
              if (window.location.href !== __lastKnownUrl) {
                __lastKnownUrl = window.location.href;
                // Navigation happened — the server-side framenavigated handler will
                // emit the navigate step after waiting for load, so we don't double-emit here.
              }
            }, 1500);
          }
        }, true);

        // Debounced input recording — captures typing in real-time (not just on blur)
        const __inputTimers = new WeakMap();
        document.addEventListener('input', (e) => {
          if (window.__qaforgeMode === 'inspect') return;
          const target = e.target;
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
            // Clear previous debounce timer for this element
            const prevTimer = __inputTimers.get(target);
            if (prevTimer) clearTimeout(prevTimer);

            // Debounce: wait 500ms of no typing before recording
            const timer = setTimeout(() => {
              if (target.__lastRecordedValue === target.value) return;
              target.__lastRecordedValue = target.value;
              const selector = getBestSelector(target);
              window.onInteractionRecorded({
                kind: 'input',
                selector: selector,
                value: target.value
              });
            }, 500);
            __inputTimers.set(target, timer);
          }
        }, true);

        // Also record on change (blur) as a safety net
        document.addEventListener('change', (e) => {
          if (window.__qaforgeMode === 'inspect') return;
          const target = e.target;
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
            // Clear any pending debounce timer
            const prevTimer = __inputTimers.get(target);
            if (prevTimer) clearTimeout(prevTimer);

            if (target.__lastRecordedValue === target.value) return;
            target.__lastRecordedValue = target.value;
            const selector = getBestSelector(target);
            window.onInteractionRecorded({
              kind: 'input',
              selector: selector,
              value: target.value
            });
          }
        }, true);

        document.addEventListener('keydown', (e) => {
          if (window.__qaforgeMode === 'inspect') return;
          const target = e.target;
          if (e.key === 'Enter' && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
            // Flush any pending input value before recording Enter
            const prevTimer = __inputTimers.get(target);
            if (prevTimer) clearTimeout(prevTimer);

            if (target.__lastRecordedValue !== target.value) {
              target.__lastRecordedValue = target.value;
              const selector = getBestSelector(target);
              window.onInteractionRecorded({
                kind: 'input',
                selector: selector,
                value: target.value
              });
            }
            const selector = getBestSelector(target);
            window.onInteractionRecorded({
              kind: 'press',
              selector: selector,
              value: 'Enter'
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
      `});

      // Start Screencast
      try {
        const client = await context.newCDPSession(page);
        cdpClient = client;
        await client.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
        client.on('Page.screencastFrame', async (frameObject) => {
          socket.emit('screencast_frame', { data: frameObject.data });
          await client.send('Page.screencastFrameAck', { sessionId: frameObject.sessionId });
        });
      } catch (cdpErr) {
        console.error('Failed to start screencast', cdpErr);
      }

      socket.emit('session_started', { success: true, url });

    } catch (error) {
      console.error(error);
      socket.emit('session_started', { success: false, error: error.message });
    }
  });

  socket.on('run_flow', async ({ url, steps, slowMo = 800 }) => {
    let runPage = null;
    let runContext = null;
    let runCdpClient = null;

    const emitLog = (level, message) => {
      socket.emit('run_log', { timestamp: new Date().toISOString(), level, message });
    };

    // === Production-grade DOM, Network, and Loader stability check ===
    async function waitForPageStability(pg, timeoutMs = 10000) {
      const start = Date.now();
      emitLog('info', '⌛ Waiting for page stability (network, DOM, loaders)…');
      
      // 1. Wait for Network to settle first
      try {
        await pg.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      } catch {}

      // 2. Wait for DOM mutations to settle and loading spinners to disappear
      try {
        const isStable = await pg.evaluate(async (timeout) => {
          return new Promise((resolve) => {
            let lastMutation = Date.now();
            const observer = new MutationObserver(() => {
              lastMutation = Date.now();
            });
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true
            });

            const checkInterval = setInterval(() => {
              const now = Date.now();
              
              // Scan for active loader elements
              const loaderSelectors = [
                '[class*="spinner"]', '[class*="loader"]', '[class*="loading"]',
                '[id*="loading"]', '[role="progressbar"]', '[class*="shimmer"]',
                '[class*="backdrop"]'
              ];
              let hasActiveLoader = false;
              for (const sel of loaderSelectors) {
                try {
                  const loaders = Array.from(document.querySelectorAll(sel));
                  const visibleLoaders = loaders.filter(el => {
                    const style = window.getComputedStyle(el);
                    const isRealSpinner = /spinner|loader|loading|shimmer/i.test(el.className + ' ' + el.id) || el.getAttribute('role') === 'progressbar';
                    return isRealSpinner && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0 && el.offsetWidth > 5 && el.offsetHeight > 5;
                  });
                  if (visibleLoaders.length > 0) {
                    hasActiveLoader = true;
                    break;
                  }
                } catch {}
              }

              const timeSinceLastMutation = now - lastMutation;
              if (timeSinceLastMutation >= 400 && !hasActiveLoader) {
                cleanup();
                resolve(true);
              } else if (now - start > timeout) {
                cleanup();
                resolve(false);
              }
            }, 100);

            const start = Date.now();
            function cleanup() {
              observer.disconnect();
              clearInterval(checkInterval);
            }
          });
        }, timeoutMs);
        
        if (isStable) {
          emitLog('info', '✓ Page is stable');
        } else {
          emitLog('warn', '⚠ Page stability timeout reached, proceeding anyway');
        }
      } catch (e) {
        await pg.waitForTimeout(600);
      }
    }

    // === Coordinate-based element blocker detection ===
    async function checkElementBlocker(pg, selector) {
      try {
        let element;
        if (selector.includes(' >> ')) {
          const parts = selector.split(' >> ');
          let loc = pg.locator(parts[0]);
          for (let p = 1; p < parts.length; p++) {
            loc = loc.locator(parts[p]);
          }
          element = await loc.first().elementHandle({ timeout: 2000 }).catch(() => null);
        } else {
          element = await pg.waitForSelector(selector, { state: 'attached', timeout: 2000 }).catch(() => null);
        }

        if (!element) return { blocked: false, reason: 'not_found' };

        await element.scrollIntoViewIfNeeded().catch(() => {});

        const isVisible = await element.isVisible();
        if (!isVisible) return { blocked: false, reason: 'invisible' };

        return await pg.evaluate((el) => {
          if (!el) return { blocked: false };

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            return { blocked: true, reason: 'zero_size' };
          }

          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;

          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
            return { blocked: false, reason: 'outside_viewport' };
          }

          const topEl = document.elementFromPoint(x, y);
          if (!topEl) return { blocked: false, reason: 'no_element_at_point' };

          let isDescendantOrSelf = el.contains(topEl) || el === topEl;
          let isAncestor = topEl.contains(el);

          if (isDescendantOrSelf || isAncestor) {
            return { blocked: false };
          }

          let parent = el.parentElement;
          while (parent) {
            if (parent === topEl) return { blocked: false };
            parent = parent.parentElement;
          }

          const blockerTag = topEl.tagName;
          const blockerClass = topEl.className?.substring?.(0, 100) || '';
          const blockerId = topEl.id || '';
          const blockerRole = topEl.getAttribute('role') || '';
          const blockerText = topEl.innerText?.substring?.(0, 50) || '';

          return {
            blocked: true,
            tag: blockerTag,
            classes: blockerClass,
            id: blockerId,
            role: blockerRole,
            text: blockerText
          };
        }, element);
      } catch (e) {
        return { blocked: false, error: e.message };
      }
    }

    // === Scoped blocker/overlay auto-dismissal ===
    async function dismissBlockingOverlay(pg, blockerInfo, targetSelector) {
      emitLog('info', `🍪 Attempting to dismiss blocking overlay: <${blockerInfo.tag} class="${blockerInfo.classes}">…`);
      try {
        const result = await pg.evaluate(({ blockerTag, blockerId, blockerClass, targetSel }) => {
          let blocker = null;
          if (blockerId) {
            blocker = document.getElementById(blockerId);
          }
          if (!blocker && blockerClass) {
            const selector = `${blockerTag}.${blockerClass.split(' ').filter(c => c.trim()).join('.')}`;
            try { blocker = document.querySelector(selector); } catch {}
          }
          if (!blocker) {
            try {
              const targetEl = document.querySelector(targetSel);
              if (targetEl) {
                const rect = targetEl.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                blocker = document.elementFromPoint(x, y);
              }
            } catch {}
          }

          if (!blocker) return { success: false, reason: 'blocker_not_found_in_dom' };

          try {
            const targetEl = document.querySelector(targetSel);
            if (targetEl && blocker.contains(targetEl)) {
              return { success: false, reason: 'target_is_inside_blocker' };
            }
          } catch {}

          const text = blocker.innerText || '';
          const isCookie = /cookie|consent|gdpr|privacy/i.test(blocker.className + ' ' + blocker.id + ' ' + text);
          const isModal = /modal|dialog|popup|overlay/i.test(blocker.className + ' ' + blocker.id + ' ' + blocker.getAttribute('role'));

          if (!isCookie && !isModal) {
            return { success: false, reason: 'blocker_is_not_cookie_or_modal' };
          }

          const buttons = Array.from(blocker.querySelectorAll('button, a, [role="button"]'));
          const acceptPatterns = [
            /accept\s*all/i, /accept\s*cookies/i, /allow\s*all/i, /agree/i, /i\s*agree/i, /accept/i, /ok/i, /continue/i
          ];
          const dismissPatterns = [
            /close/i, /dismiss/i, /no\s*thanks/i, /maybe\s*later/i
          ];

          if (isCookie) {
            for (const pattern of acceptPatterns) {
              const btn = buttons.find(b => pattern.test(b.innerText || b.getAttribute('aria-label') || ''));
              if (btn) {
                btn.click();
                return { success: true, clicked: btn.innerText || btn.tagName, type: 'cookie' };
              }
            }
          }

          for (const pattern of dismissPatterns) {
            const btn = buttons.find(b => pattern.test(b.innerText || b.getAttribute('aria-label') || ''));
            if (btn) {
              btn.click();
              return { success: true, clicked: btn.innerText || btn.tagName, type: 'dismiss' };
            }
          }

          for (const pattern of acceptPatterns) {
            const btn = buttons.find(b => pattern.test(b.innerText || b.getAttribute('aria-label') || ''));
            if (btn) {
              btn.click();
              return { success: true, clicked: btn.innerText || btn.tagName, type: 'accept_fallback' };
            }
          }

          const closeIconBtn = buttons.find(b => {
            const cls = b.className || '';
            const label = b.getAttribute('aria-label') || '';
            return /close|btn-close|modal__close/i.test(cls) || /close/i.test(label) || (b.innerText?.trim() === '×');
          });
          if (closeIconBtn) {
            closeIconBtn.click();
            return { success: true, clicked: 'close_icon', type: 'close_icon' };
          }

          return { success: false, reason: 'no_matching_button_found_inside_blocker' };
        }, { blockerTag: blockerInfo.tag, blockerId: blockerInfo.id, blockerClass: blockerInfo.classes, targetSel: targetSel });

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

    // === Scoped blocker/overlay auto-dismissal and page stability resolver ===
    async function resolveBlocker(pg, escapedSelector, label) {
      await waitForPageStability(pg);

      let blocker = await checkElementBlocker(pg, escapedSelector);
      if (blocker && blocker.blocked) {
        emitLog('info', `${label} — Target element is blocked by <${blocker.tag} id="${blocker.id}" class="${blocker.classes}">. Resolving…`);
        
        const isLoader = /spinner|loader|loading|shimmer/i.test(blocker.classes + ' ' + blocker.id) || blocker.role === 'progressbar';
        if (isLoader) {
          emitLog('info', `${label} — Blocker is a loader/spinner. Waiting for it to disappear…`);
          const startWait = Date.now();
          while (Date.now() - startWait < 5000) {
            await pg.waitForTimeout(400);
            blocker = await checkElementBlocker(pg, escapedSelector);
            if (!blocker || !blocker.blocked) {
              emitLog('info', `${label} — Loader disappeared.`);
              break;
            }
          }
        }

        // If still blocked, check for cookie banner or modal overlay to dismiss
        if (blocker && blocker.blocked) {
          const text = blocker.text || '';
          const isCookie = /cookie|consent|gdpr|privacy/i.test(blocker.classes + ' ' + blocker.id + ' ' + text);
          const isModal = /modal|dialog|popup|overlay/i.test(blocker.classes + ' ' + blocker.id + ' ' + blocker.role);
          
          if (isCookie || isModal) {
            const dismissed = await dismissBlockingOverlay(pg, blocker, escapedSelector);
            if (dismissed) {
              await pg.waitForTimeout(500);
              blocker = await checkElementBlocker(pg, escapedSelector);
            }
          }
        }

        // If still blocked, wait up to 3 seconds for transition/animation
        if (blocker && blocker.blocked) {
          emitLog('info', `${label} — Still blocked. Waiting up to 3s for blocker to animate/transition out…`);
          const startWait = Date.now();
          while (Date.now() - startWait < 3000) {
            await pg.waitForTimeout(300);
            blocker = await checkElementBlocker(pg, escapedSelector);
            if (!blocker || !blocker.blocked) {
              emitLog('info', `${label} — Blocker animated/transitioned out.`);
              break;
            }
          }
        }
      }
    }

    // === Problem 2: Highlight element before interacting ===
    async function highlightElement(pg, selector) {
      try {
        await pg.evaluate((sel) => {
          // Try to find the element — support both CSS and Playwright chained selectors
          let el = null;
          if (sel.includes(' >> ')) {
            // Chained selector — just try the last part as a rough visual highlight
            const parts = sel.split(' >> ');
            const container = document.querySelector(parts[0].replace(/:has-text\(.*?\)/, ''));
            if (container) {
              const inner = container.querySelector(parts[parts.length - 1]);
              el = inner || container;
            }
          } else {
            el = document.querySelector(sel);
          }
          if (!el) return;

          // Apply highlight
          el.style.outline = '3px solid #00ff88';
          el.style.outlineOffset = '2px';
          el.style.boxShadow = '0 0 20px rgba(0,255,136,0.5), 0 0 40px rgba(0,255,136,0.2)';
          el.style.transition = 'outline 0.3s ease, box-shadow 0.3s ease';
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });

          setTimeout(() => {
            el.style.outline = '';
            el.style.outlineOffset = '';
            el.style.boxShadow = '';
          }, 1200);
        }, selector);
        // Give time for the highlight to render and the screencast to capture it
        await pg.waitForTimeout(400);
      } catch {
        // Highlighting is best-effort, don't break the flow
      }
    }

    // === Problem 1: Click using locator for chained >> selectors ===
    async function clickWithLocator(pg, selector, label) {
      if (selector.includes(' >> ')) {
        // Playwright chained locator syntax — use locator API
        emitLog('info', `${label} — Using chained locator: ${selector}`);
        const parts = selector.split(' >> ');
        let loc = pg.locator(parts[0]);
        for (let p = 1; p < parts.length; p++) {
          loc = loc.locator(parts[p]);
        }
        await loc.first().click({ timeout: 5000 });
        return true;
      }
      return false; // Not a chained selector
    }

    // === Wait for element bounding box stability (animations completed) ===
    async function waitForStableBoundingBox(pg, selector, timeoutMs = 2500) {
      try {
        let loc;
        if (selector.includes(' >> ')) {
          const parts = selector.split(' >> ');
          let l = pg.locator(parts[0]);
          for (let p = 1; p < parts.length; p++) {
            l = l.locator(parts[p]);
          }
          loc = l.first();
        } else {
          loc = pg.locator(selector).first();
        }

        const start = Date.now();
        let prevBox = null;
        let stableCount = 0;

        while (Date.now() - start < timeoutMs) {
          const isVisible = await loc.isVisible().catch(() => false);
          if (!isVisible) {
            await pg.waitForTimeout(100);
            continue;
          }

          const box = await loc.boundingBox().catch(() => null);
          if (box) {
            if (prevBox &&
                Math.abs(box.x - prevBox.x) < 0.5 &&
                Math.abs(box.y - prevBox.y) < 0.5 &&
                Math.abs(box.width - prevBox.width) < 0.5 &&
                Math.abs(box.height - prevBox.height) < 0.5) {
              stableCount++;
              if (stableCount >= 3) {
                return true; // Bounding box has settled
              }
            } else {
              stableCount = 0;
            }
            prevBox = box;
          }
          await pg.waitForTimeout(50);
        }
      } catch (err) {
        // Best effort
      }
      return false;
    }

    // === Post-action lookahead validation helper ===
    async function runLookaheadValidation(pg, nextSelector, label) {
      await waitForPageStability(pg);
      if (nextSelector) {
        emitLog('info', `${label} — Post-action lookahead validation: Waiting for next step's selector "${nextSelector}" to become visible and stable…`);
        try {
          let loc;
          if (nextSelector.includes(' >> ')) {
            const parts = nextSelector.split(' >> ');
            let l = pg.locator(parts[0]);
            for (let p = 1; p < parts.length; p++) {
              l = l.locator(parts[p]);
            }
            loc = l.first();
          } else {
            loc = pg.locator(nextSelector).first();
          }
          
          await loc.waitFor({ state: 'visible', timeout: 3000 });
          const isStable = await waitForStableBoundingBox(pg, nextSelector, 2000);
          if (isStable) {
            emitLog('info', `${label} — Next step's selector is visible and stable.`);
          } else {
            emitLog('info', `${label} — Next step's selector is visible (stabilization timed out).`);
          }
        } catch (e) {
          emitLog('info', `${label} — Lookahead validation finished (next selector not yet visible/stable).`);
        }
      }
    }

    try {
      emitLog('info', `Launching browser… (slowMo: ${slowMo}ms)`);
      if (!browser) browser = await chromium.launch({ headless: true });
      runContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      runPage = await runContext.newPage();

      // === Problem 3: Auto-dismiss native browser dialogs ===
      runPage.on('dialog', async (dialog) => {
        const type = dialog.type();
        const msg = dialog.message();
        emitLog('info', `🔔 Native dialog detected: [${type}] "${msg}"`);
        socket.emit('popup_detected', { type: 'dialog', dialogType: type, message: msg });
        try {
          if (type === 'prompt') {
            await dialog.accept('');
          } else {
            await dialog.accept();
          }
          emitLog('info', `🔔 Native dialog auto-accepted`);
        } catch (e) {
          emitLog('warn', `Could not dismiss dialog: ${e.message}`);
        }
      });

      // Setup Page request/response listeners for API mapping
      let currentStepId = null;
      const requestStartTimes = new Map();

      runPage.on('request', (request) => {
        const reqUrl = request.url();
        const resourceType = request.resourceType();

        // Only capture fetch/xhr and skip internal tools / socket / static assets
        if (
          (resourceType === 'fetch' || resourceType === 'xhr') &&
          !reqUrl.includes('/socket.io/') &&
          !reqUrl.includes('localhost:4000')
        ) {
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

          try {
            responseText = await response.text();
          } catch (e) {
            // response body might not be text or already closed
          }

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

      // Start CDP screencast so the client can see the live browser
      try {
        runCdpClient = await runContext.newCDPSession(runPage);
        await runCdpClient.send('Page.startScreencast', {
          format: 'jpeg', quality: 55, everyNthFrame: 1,
          maxWidth: 1280, maxHeight: 800
        });
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
          if (nextStep.selector) {
            nextStepSelector = escapeCssSelector(nextStep.selector);
          }
        }

        // === Problem 2: Pre-step slow-mo delay ===
        if (slowMo > 0 && i > 0) {
          await runPage.waitForTimeout(slowMo);
        }

        try {
          if (step.kind === 'navigate') {
            const targetUrl = step.value || url;
            let alreadyNavigated = false;

            try {
              // Wait up to 3 seconds for the page to reach the target URL naturally (e.g. via redirects)
              await runPage.waitForURL((urlObj) => {
                const normCurrent = urlObj.toString().toLowerCase().replace(/\/$/, '').split('?')[0];
                const normTarget = targetUrl.toLowerCase().replace(/\/$/, '').split('?')[0];
                return normCurrent === normTarget || normCurrent.endsWith(normTarget) || normTarget.endsWith(normCurrent);
              }, { timeout: 3000 });
              alreadyNavigated = true;
              emitLog('info', `${label} — Already at target URL or navigated naturally. Skipping hard reload.`);
            } catch (err) {
              // Page did not navigate naturally within 3 seconds
            }

            if (!alreadyNavigated) {
              emitLog('info', `${label} — Performing hard navigation to ${targetUrl}`);
              await runPage.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
            }
            await waitForPageStability(runPage);

          } else if (step.kind === 'wait') {
            const ms = parseInt(step.value || '1000');
            emitLog('info', `${label} — waiting ${ms}ms`);
            await runPage.waitForTimeout(ms);
          } else if (step.kind === 'click' && step.selector) {
            const escapedSelector = escapeCssSelector(step.selector);
            let clicked = false;
            let lastError = null;

            await resolveBlocker(runPage, escapedSelector, label);
            await highlightElement(runPage, escapedSelector);

            try {
              // === Problem 1: Try chained locator first for >> selectors ===
              if (step.selector.includes(' >> ')) {
                clicked = await clickWithLocator(runPage, step.selector, label);
              } else {
                // Try the original exact selector with a moderate timeout (3.5s)
                emitLog('info', `${label} — Waiting for element: ${escapedSelector}`);
                await runPage.waitForSelector(escapedSelector, { state: 'visible', timeout: 3500 });
                await runPage.click(escapedSelector, { timeout: 4500 });
                clicked = true;
              }
            } catch (err) {
              lastError = err;
              emitLog('warn', `${label} — Click with primary selector failed: ${err.message}`);
            }

            // Fallback for text selectors if the primary selector failed
            if (!clicked && step.selector.startsWith('text=')) {
              // Extract raw text from text="TEXT" or text=TEXT
              let rawText = step.selector.slice(5);
              if (rawText.startsWith('"') && rawText.endsWith('"')) {
                rawText = rawText.slice(1, -1);
              }
              // Unescape quotes and backslashes
              rawText = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

              // Escape any special characters for regex
              const escapedRegex = rawText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

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
                  await runPage.waitForSelector(fb.selector, { state: 'visible', timeout: fb.timeout });
                  await runPage.click(fb.selector, { timeout: fb.timeout });
                  clicked = true;
                  emitLog('info', `${label} — Clicked successfully using fallback: ${fb.selector}`);
                  break;
                } catch (fallbackErr) {
                  // Suppress fallback error and try next
                }
              }
            }

            if (!clicked) {
              throw lastError || new Error(`Failed to click selector: ${step.selector}`);
            }

            await runLookaheadValidation(runPage, nextStepSelector, label);

          } else if (step.kind === 'input' && step.selector) {
            const escapedSelector = escapeCssSelector(step.selector);

            await resolveBlocker(runPage, escapedSelector, label);
            await highlightElement(runPage, escapedSelector);

            await runPage.waitForSelector(escapedSelector, { timeout: 8000 });
            try {
              // Clear first
              await runPage.fill(escapedSelector, '');
              if (step.value) {
                // Simulate human key typing for proper events/autocomplete/popups triggering
                await runPage.pressSequentially(escapedSelector, step.value, { delay: 40, timeout: 5000 });
              }
            } catch (err) {
              // Fallback to instant fill
              await runPage.fill(escapedSelector, step.value || '', { timeout: 5000 });
            }
            await runLookaheadValidation(runPage, nextStepSelector, label);
          } else if (step.kind === 'press' && step.selector) {
            // Press key step handler (e.g. pressing 'Enter' to submit form)
            const escapedSelector = escapeCssSelector(step.selector);

            await resolveBlocker(runPage, escapedSelector, label);
            await highlightElement(runPage, escapedSelector);

            await runPage.waitForSelector(escapedSelector, { timeout: 8000 });
            emitLog('info', `${label} — pressing key "${step.value || 'Enter'}"`);
            await runPage.press(escapedSelector, step.value || 'Enter', { timeout: 5000 });
            await runLookaheadValidation(runPage, nextStepSelector, label);

          } else if (step.kind === 'scroll') {
            await runPage.evaluate((val) => window.scrollBy(0, parseInt(val || '300')), step.value);
            await runPage.waitForTimeout(300);
          } else if (step.kind === 'assert' && step.selector) {
            const escapedSelector = escapeCssSelector(step.selector);

            // === Problem 2: Highlight the asserted element ===
            await highlightElement(runPage, escapedSelector);

            // Support chained selectors for assert too
            let el = null;
            if (step.selector.includes(' >> ')) {
              const parts = step.selector.split(' >> ');
              let loc = runPage.locator(parts[0]);
              for (let p = 1; p < parts.length; p++) {
                loc = loc.locator(parts[p]);
              }
              el = await loc.first().elementHandle({ timeout: 8000 }).catch(() => null);
            } else {
              el = await runPage.waitForSelector(escapedSelector, { timeout: 8000 }).catch(() => null);
            }
            if (!el) throw new Error(`Assertion failed: element "${step.selector}" not found`);
          }

          emitLog('pass', `${label} — passed ✓`);
          socket.emit('step_completed', { stepId: step.id, status: 'pass' });
        } catch (error) {
          console.error(`Step failed: ${step.id}`, error);
          emitLog('fail', `${label} — FAILED: ${error.message}`);
          socket.emit('step_completed', { stepId: step.id, status: 'fail', error: error.message });
          break; // Stop execution on failure
        }
      }

      // Wait for any final redirects or page updates to settle before closing browser
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
      // Stop screencast and clean up run-specific context
      if (runCdpClient) {
        try { await runCdpClient.send('Page.stopScreencast'); } catch { }
      }
      if (runPage) { await runPage.close().catch(() => { }); }
      if (runContext) { await runContext.close().catch(() => { }); }
    }
  });

  socket.on('set_mode', async ({ mode }) => {
    if (!page) return;
    try { await page.evaluate((m) => { window.__qaforgeMode = m; }, mode); } catch { }
  });

  // Forward user interactions to the live page
  socket.on('forward_click', async ({ x, y, button }) => {
    if (!page) return;
    try { await page.mouse.click(Math.round(x), Math.round(y), { button: button || 'left' }); }
    catch (e) { console.error('forward_click', e.message); }
  });

  socket.on('inspect_click', async ({ x, y, button }) => {
    if (!page) return;
    try { await page.mouse.click(Math.round(x), Math.round(y), { button: button || 'left' }); }
    catch (e) { console.error('inspect_click', e.message); }
  });

  socket.on('forward_scroll', async ({ x, y, deltaX, deltaY }) => {
    if (!page) return;
    try {
      await page.mouse.move(Math.round(x), Math.round(y));
      await page.mouse.wheel(deltaX || 0, deltaY || 0);
    } catch (e) { console.error('forward_scroll', e.message); }
  });

  socket.on('forward_move', async ({ x, y }) => {
    if (!page) return;
    try { await page.mouse.move(Math.round(x), Math.round(y)); }
    catch { }
  });

  socket.on('forward_key', async ({ key }) => {
    if (!page) return;
    try { await page.keyboard.press(key); } catch (e) { console.error('forward_key', e.message); }
  });

  socket.on('forward_type', async ({ text }) => {
    if (!page) return;
    try { await page.keyboard.type(text); } catch (e) { console.error('forward_type', e.message); }
  });

  socket.on('stop_session', async () => {
    if (page) {
      await page.close().catch(() => { });
      page = null;
    }
    if (context) {
      await context.close().catch(() => { });
      context = null;
    }
    socket.emit('session_stopped');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Automation Server running on port ${PORT}`);
});
