// netlify/functions/ocr.js
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { imageBase64, memberName = 'Partner 1' } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return { statusCode: 400, body: 'Missing imageBase64' };
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: 'OPENAI_API_KEY not set' };
    }

    const today = new Date().toISOString().slice(0,10);

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [
          { role: 'system', content: `
You are a finance assistant. Read the receipt / UPI payment screenshot and return JSON:
{
  "amount": number,           // in INR (no commas)
  "expense_date": "yyyy-mm-dd",
  "category": "Groceries|Food & Dining|Fuel|Transport|Rent|Bills & Utilities|Shopping|Entertainment|Health|Other",
  "description": "3-6 words",
  "raw_text": "all visible text from the image"
}
If unsure, still fill best guess. Output ONLY JSON.
`},
          {
            role: 'user',
            content: [
              { type: 'text', text: `Today is ${today}. If rupee symbol ₹ or "Rs" shows, it's INR. Prefer merchant/payee name in description.` },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 300
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      return { statusCode: 502, body: `OpenAI error: ${t}` };
    }
    const data = await resp.json();

    // Try to parse JSON from the model (handles string OR array content)
    let parsed;
    try {
      const content = data.choices?.[0]?.message?.content;
      const textOut = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.map(p => p?.text ?? '').join(' ') : '{}');
      parsed = JSON.parse(textOut || '{}');
    } catch (_) {
      parsed = {};
    }

    // ---------- post-process & fallbacks ----------
    const raw = (parsed.raw_text || '').toString();

    // amount: look for ₹ or Rs patterns if missing/zero
    let amount = Number(parsed.amount || 0);
    if (!amount || isNaN(amount)) {
      const m1 = raw.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/i) || raw.match(/rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
      if (m1?.[1]) amount = Number(m1[1].replace(/,/g, ''));
    }

    // date: accept “29 August 2025” or “29 Aug 2025” or 2025-08-29 / 29-08-2025
    let expense_date = (parsed.expense_date || '').slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
      const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
      let d = null;

      // 29 August 2025
      const long = raw.match(/\b(\d{1,2})\s+([A-Za-z]{3,})[a-z]*\s+(\d{4})\b/);
      if (long) {
        const day = Number(long[1]);
        const mon = months[long[2].slice(0,3).toLowerCase()];
        const yr  = Number(long[3]);
        if (mon) d = new Date(Date.UTC(yr, mon-1, day));
      }

      // 29-08-2025 or 29/08/2025
      const dmy = raw.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
      if (!d && dmy) d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2])-1, Number(dmy[1])));

      // 2025-08-29
      const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
      if (!d && iso) d = new Date(Date.UTC(Number(iso[1]), Number(iso[2])-1, Number(iso[3])));

      if (d && !isNaN(d)) expense_date = d.toISOString().slice(0,10);
    }
    if (!expense_date) expense_date = today;

    // category: simple merchant-based hint if model didn’t give one
    let category = parsed.category || 'Other';
    if (category === 'Other') {
      const lower = raw.toLowerCase();
      if (/\b(bakery|baking|cafe|restaurant|hotel|food|eatery)\b/.test(lower)) category = 'Food & Dining';
    }

    // description: prefer merchant/payee line
    let description = parsed.description || '';
    if (!description) {
      const paidTo = raw.match(/paid\s+to\s+(.+)\b/i);
      description = paidTo?.[1]?.trim().slice(0, 60) || 'Receipt import';
    }

    // finalized fields
    const out = {
      memberName,
      amount: Number(amount || 0),
      expense_date,
      category,
      currency: 'INR',
      description,
      source: 'image'
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    };
  } catch (e) {
    return { statusCode: 500, body: `Server error: ${e.message}` };
  }
};

