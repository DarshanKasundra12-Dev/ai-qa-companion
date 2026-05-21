import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { chromium } from 'playwright';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      
      // Inject CSS for highlighting
      await page.addStyleTag({ content: `
        .qaforge-highlight {
          outline: 2px dashed #ff00ff !important;
          background-color: rgba(255, 0, 255, 0.1) !important;
          cursor: crosshair !important;
        }
      `});

      // Inject JS for element selection (toggle via window.__qaforgeMode)
      await page.addScriptTag({ content: `
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

        document.addEventListener('click', (e) => {
          if (window.__qaforgeMode !== 'inspect') return;
          e.preventDefault();
          e.stopPropagation();
          const target = e.target;
          const elData = {
            tagName: target.tagName,
            id: target.id,
            className: target.className,
            text: target.innerText?.substring(0, 50),
            placeholder: target.placeholder,
            name: target.name,
            role: target.getAttribute('role'),
            ariaLabel: target.getAttribute('aria-label'),
            dataTestId: target.getAttribute('data-testid'),
            xpath: getXPath(target)
          };
          window.onElementSelected(elData);
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

  socket.on('run_flow', async ({ url, steps }) => {
    try {
      if (!browser) browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
      page = await context.newPage();
      
      socket.emit('run_started', { url });
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        socket.emit('step_running', { stepId: step.id });
        
        try {
          if (step.kind === 'navigate') {
            await page.goto(step.value || url, { waitUntil: 'domcontentloaded' });
          } else if (step.kind === 'wait') {
            await page.waitForTimeout(parseInt(step.value || '1000'));
          } else if (step.kind === 'click' && step.selector) {
            try {
              await page.click(step.selector, { timeout: 3000 });
            } catch (err) {
              // Self-healing attempt!
              socket.emit('step_healing', { stepId: step.id, oldSelector: step.selector });
              const dom = await page.evaluate(() => document.body.innerHTML);
              const prompt = `The UI test failed to click on "${step.selector}". Here is the page HTML:\n${dom.substring(0, 15000)}\nFind a robust alternative selector for this element. Return only the string for the selector.`;
              
              const response = await ai.models.generateContent({
                model: 'gemini-3-flash',
                contents: prompt,
              });
              
                let newSelector = response.text.trim();
                if (newSelector.startsWith('```')) {
                  newSelector = newSelector.replace(/```[a-z]*\n?/g, '').replace(/\n?```$/g, '');
                }
              
              socket.emit('step_healed', { stepId: step.id, oldSelector: step.selector, newSelector });
              
              // Retry with new selector
              await page.click(newSelector, { timeout: 3000 });
            }
          } else if (step.kind === 'input' && step.selector) {
            await page.fill(step.selector, step.value || '', { timeout: 3000 });
          }
          
          socket.emit('step_completed', { stepId: step.id, status: 'pass' });
        } catch (error) {
          console.error(`Step failed: ${step.id}`, error);
          socket.emit('step_completed', { stepId: step.id, status: 'fail', error: error.message });
          break; // Stop execution on failure
        }
      }
      socket.emit('run_finished', { success: true });
    } catch (error) {
      console.error(error);
      socket.emit('run_finished', { success: false, error: error.message });
    }
  });

  // Forward user interactions to the live page
  socket.on('forward_click', async ({ x, y, button }) => {
    if (!page) return;
    try { await page.mouse.click(Math.round(x), Math.round(y), { button: button || 'left' }); }
    catch (e) { console.error('forward_click', e.message); }
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
    catch {}
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
      await page.close().catch(() => {});
      page = null;
    }
    if (context) {
      await context.close().catch(() => {});
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
