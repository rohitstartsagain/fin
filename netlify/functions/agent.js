// netlify/functions/agent.js
// Requires: OPENAI_API_KEY env var + netlify/functions/prompt.txt
// Input:  { memberName?: "Partner 1"|"Partner 2", text?: string, imageBase64?: string }
// Output: { mode:"expense", expense:{...}, memberName } OR { mode:"query", query:{...}, memberName } OR { needs_clarification:true, message:"..." }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // --- load prompt from file (server-side; not in app.js) ---
  const fs = require('fs');
  const path = require('path');
  const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompt.txt'), 'utf8');

  try {
    const { memberName = 'Partner 1', text = '', imageBase64 = null } = JSON.parse(event.body || '{}');

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: 'OPENAI_API_KEY not set' };
    }

    const today = new Date().toISOString().slice(0, 10);
    const content = [
      { type: 'text', text: `Today is ${today}. Member: ${memberName}. Decide EXPENSE vs QUERY; output JSON only.` }
    ];
    if (text) content.push({ type: 'text', text });
    if (imageBase64) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } });

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',                          // or 'gpt-5-mini' if you prefer
        max_completion_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content }
        ]
      })
    });

    const raw = await resp.text();
    if (!resp.ok) {
      return { statusCode: resp.status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: raw }) };
    }

    const data = JSON.parse(raw);
    const msg = data.choices?.[0]?.message?.content;
    const textOut = typeof msg === 'string'
      ? msg
      : (Array.isArray(msg) ? msg.map(p => p?.text ?? '').join(' ') : '{}');

    let parsed;
    try { parsed = JSON.parse(textOut || '{}'); } catch { parsed = {}; }

    // normalize outputs a bit & echo memberName so client can attribute correctly
    if (parsed.mode === 'expense' && parsed.expense) {
      const e = parsed.expense;
      if (!e.amount || !e.date || !e.category) {
        return ok({ needs_clarification: true, message: "Need amount, date, and category to log this. Please confirm or edit." });
      }
      e.currency = e.currency || 'INR';
      e.source = e.source || (imageBase64 ? 'image' : (text ? 'text' : 'sms'));
      return ok({ mode: 'expense', expense: e, memberName });
    }

    if (parsed.mode === 'query' && parsed.query) {
      return ok({ mode: 'query', query: parsed.query, memberName });
    }

    if (parsed.needs_clarification) {
      return ok({ needs_clarification: true, message: parsed.message || "Please clarify." });
    }

    return ok({ needs_clarification: true, message: "I couldn't parse that. Is it an expense or a query?" });

  } catch (err) {
    return { statusCode: 500, body: `Server error: ${err?.message || err}` };
  }

  function ok(obj) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
  }
};
