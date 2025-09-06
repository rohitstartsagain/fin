// netlify/functions/agent.js
const fs = require('fs');
const path = require('path');

function loadSystemPrompt() {
  const fromEnv = (process.env.FIN_AGENT_SYSTEM_PROMPT || '').trim();
  if (fromEnv) return fromEnv;
  const p = path.join(__dirname, 'prompt.txt');
  return fs.readFileSync(p, 'utf8');
}
const SYSTEM_PROMPT = loadSystemPrompt();
const fs   = require('fs');
const path = require('path');

function readPrompt() {
  const candidates = [
    // when running in Netlify, __dirname is the function folder
    path.join(__dirname, 'prompt.txt'),
    // fallback: absolute path from repo root (useful locally)
    path.join(process.cwd(), 'netlify', 'functions', 'prompt.txt'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {}
  }
  throw new Error('prompt.txt not found in function bundle');
}

const systemPrompt = readPrompt();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { userText = '', memberName = 'Partner 1' } = JSON.parse(event.body || '{}');
    if (!process.env.OPENAI_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };
    }

    const today = new Date().toISOString().slice(0, 10);

    // Force JSON: response_format: { type: 'json_object' }
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `TODAY=${today}\nMEMBER=${memberName}\n\n` +
              `User says: """${userText}"""\n\n` +
              `Return a JSON object with one of these:\n` +
              `{"mode":"expense","expense":{"amount":number,"currency":"INR","expense_date":"yyyy-mm-dd","category":string,"description":string}}\n` +
              `or {"mode":"query","start":"yyyy-mm-dd","end":"yyyy-mm-dd","category":null|Category,"scope":"me|household"}\n` +
              `or {"mode":"needs_clarification","message":string}\n` +
              `Return ONLY JSON.`
          }
        ]
      })
    });

    const raw = await resp.text();
    if (!resp.ok) {
      // Pass model/server error back to UI so you see it
      return { statusCode: resp.status, body: raw };
    }

    let content;
    try {
      const data = JSON.parse(raw);
      content = data?.choices?.[0]?.message?.content || '{}';
    } catch {
      // If OpenAI body wasn’t JSON for some reason
      content = raw;
    }

    let out;
    try { out = JSON.parse(content); } catch { out = null; }

    if (!out || !out.mode) {
      out = { mode: 'needs_clarification', message: 'Could not parse JSON reply.' };
    }

    // Normalize expense
    if (out.mode === 'expense' && out.expense) {
      const e = out.expense;
      if (e.amount != null) e.amount = Number(e.amount);
      if (!e.currency) e.currency = 'INR';
      if (!e.expense_date) e.expense_date = today;
      if (!e.category) e.category = 'Other';
      if (!e.description) e.description = userText;
    }

    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
