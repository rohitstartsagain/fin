// netlify/functions/agent.js

const fs   = require('fs');          // declare ONCE at top
const path = require('path');

function readPrompt() {
  const candidates = [
    path.join(__dirname, 'prompt.txt'),
    path.join(process.cwd(), 'netlify', 'functions', 'prompt.txt'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (_) {}
  }
  throw new Error('prompt.txt not found in function bundle');
}

const SYSTEM_PROMPT = readPrompt();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { userText = '', memberName = 'Partner 1' } = JSON.parse(event.body || '{}');

    // Build the instruction for the router-style agent
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          JSON.stringify({
            userText,
            memberName,
          }),
      },
    ];

    // Call OpenAI (Node 18+ has global fetch on Netlify)
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
      }),
    });

    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }

    if (!resp.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: data?.error?.message || raw }),
      };
    }

    // Expect model to return a JSON object in assistant message content
    const content = data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = {}; }

    return {
      statusCode: 200,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err && err.message || err) }),
    };
  }
};
