#!/usr/bin/env node
'use strict';
/*
 * WIRflow backend — serves the static site and provides POST /api/parse,
 * an LLM-powered natural-language → form-fields extractor.
 *
 * Zero npm dependencies (Node 18+, built-in fetch). Provider-agnostic:
 * point it at any OpenAI-compatible chat-completions API (Groq, DeepSeek,
 * OpenRouter, Gemini compat, OpenAI, ...) or at Anthropic's native API.
 * All configuration is via environment variables — see .env.example.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---------------- config ---------------- */
const PORT = Number(process.env.PORT || 3000);
const PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase(); // 'openai' (any compatible) | 'anthropic'
const BASE_URL = (process.env.LLM_BASE_URL ||
  (PROVIDER === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
).replace(/\/+$/, '');
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini');
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);
const MAX_BODY = 64 * 1024;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/* ---------------- rate limiting (in-memory, per IP) ---------------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10000) hits.clear(); // crude memory guard
  return recent.length > RATE_LIMIT_PER_MIN;
}

/* ---------------- LLM providers ---------------- */
async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible(system, user) {
  const res = await fetchWithTimeout(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + API_KEY,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || JSON.stringify(data).slice(0, 300);
    throw new Error(`Provider error ${res.status}: ${msg}`);
  }
  return data.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(system, user) {
  const res = await fetchWithTimeout(BASE_URL + '/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || JSON.stringify(data).slice(0, 300);
    throw new Error(`Provider error ${res.status}: ${msg}`);
  }
  if (data.stop_reason === 'refusal') throw new Error('The model declined this request.');
  const block = (data.content || []).find((b) => b.type === 'text');
  return block ? block.text : '';
}

const callLLM = PROVIDER === 'anthropic' ? callAnthropic : callOpenAICompatible;

/* ---------------- extraction prompt ---------------- */
function buildPrompt(fields, dateFormat) {
  const now = new Date();
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  const iso = now.toISOString().slice(0, 10);
  return [
    "You extract structured form-field values from a construction site engineer's shorthand notes",
    'for a Work Inspection Request (WIR) or similar submittal form.',
    `Today's date is ${iso} (${weekday}).`,
    `The form has exactly these field names: ${fields.join(', ')}.`,
    'Return ONLY a JSON object mapping field names (spelled exactly as given) to string values.',
    'Rules:',
    '- Include only fields the note actually provides a value for. Never invent or guess values.',
    `- Resolve relative dates ("today", "tomorrow", "next monday") to the format ${dateFormat}.`,
    '- Values must be plain strings, concise, ready to appear on the form as-is.',
    '- Understand site shorthand and abbreviations (dwg = drawing, qty = quantity, GF = ground floor,',
    '  B1 = basement 1, rebar = reinforcement, MEP disciplines, grid references, revision numbers, etc.).',
    '- If several values map to one field (e.g. multiple drawing numbers), join them with ", ".',
    'Output nothing but the JSON object — no prose, no markdown fences.',
  ].join('\n');
}

function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Model did not return JSON.');
  const obj = JSON.parse(t.slice(start, end + 1));
  // tolerate a {"values": {...}} wrapper
  if (obj && typeof obj.values === 'object' && obj.values !== null && !Array.isArray(obj.values)) return obj.values;
  return obj;
}

/* ---------------- request helpers ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/* ---------------- API handlers ---------------- */
async function handleParse(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests — try again in a minute.' });
  if (!API_KEY) return sendJson(res, 503, { error: 'No LLM API key configured on the server.' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON body.' });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const fields = Array.isArray(body.fields) ? body.fields.filter((f) => typeof f === 'string' && f.length <= 100) : [];
  const dateFormat = typeof body.dateFormat === 'string' && body.dateFormat.length <= 20 ? body.dateFormat : 'DD-MM-YYYY';

  if (!text) return sendJson(res, 400, { error: 'Missing "text".' });
  if (text.length > 8000) return sendJson(res, 400, { error: 'Text too long (max 8000 characters).' });
  if (!fields.length || fields.length > 100) return sendJson(res, 400, { error: 'Provide 1-100 field names.' });

  try {
    const raw = await callLLM(buildPrompt(fields, dateFormat), text);
    const parsed = extractJson(raw);
    const values = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (fields.includes(k) && v != null && String(v).trim() !== '') values[k] = String(v).trim();
    }
    return sendJson(res, 200, { values, model: MODEL });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'LLM request timed out.' : err.message || 'LLM request failed.';
    console.error(`[parse] ${msg}`);
    return sendJson(res, 502, { error: msg });
  }
}

function handleHealth(res) {
  sendJson(res, 200, { ok: Boolean(API_KEY), provider: PROVIDER, model: API_KEY ? MODEL : null });
}

/* ---------------- static files ---------------- */
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- server ---------------- */
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  const route = req.url.split('?')[0];
  if (route === '/api/health' && req.method === 'GET') return handleHealth(res);
  if (route === '/api/parse' && req.method === 'POST') return void handleParse(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`WIRflow server on http://localhost:${PORT}`);
  console.log(`LLM provider: ${PROVIDER} | model: ${MODEL} | key configured: ${Boolean(API_KEY)}`);
  if (!API_KEY) console.log('No LLM_API_KEY set — the site works, but AI parsing is disabled (rule-based parsing still works in the browser).');
});
