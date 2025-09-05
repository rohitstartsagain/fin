// netlify/functions/ocr.js
// Requires site env var: OPENAI_API_KEY
// Works with GPT-5 (vision) and returns robust JSON with regex fallbacks.

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

    const today = new Date().toISOString().slice(0, 10);

    // ---- Choose model here ----
    const MODEL = 'gpt-5';        // or 'gpt-5-mini' (cheaper) or 'gpt-4o' (if needed)

    const prompt = `
You are a finance assistant. Read the receipt / UPI payment screenshot and return a single JSON object:
{
  "amount": number,                // INR amount (no commas)
  "expense_date": "yyyy-mm-dd",    // transaction date
  "category": "Groceries|Food & Dining|Fuel|Transport|Rent|Bills & Utilities|Shopping|Entertainment|Health|Other",
  "description": "3-6 words",      // merchant/payee or short label
  "raw_text": "all visible text from the image (optional but helpful)"
}
If unsure, still fill your best guess. Output ONLY JSON.
`;

    // ---- OpenAI call (GPT-5-safe params) ----
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        // GPT-5 accepts max_completion_tokens (NOT max_tokens). Omit temperature/top_p/penalties.
        max_completion_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Today is ${today}. Prefer merchant/payee name in description.` },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
            ]
          }
        ]
      })
    });

    const raw = await resp.text();
    if (!resp.ok) {
      // Return a readable error to the UI (your app already shows this nicely)
      return {
        statusCode: resp.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: 'OpenAI error', detail: raw } })
      };
    }

    const data = JSON.parse(raw);

    // ---- Parse JSON content safely (string or array parts) ----
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

    // ---------- Post-process & fallbacks ----------
    const rawText = (parsed.raw_text || '').toString();

    // Amount: find ₹ or Rs patterns if model missed/zero
    let amount = Number(parsed.amount || 0);
    if (!amount || isNaN(amount)) {
      const m = rawText.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/i) || rawText.match(/\brs\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
      if (m?.[1]) amount = Number(m[1].replace(/,/g, ''));
    }

    // Date: accept “29 August 2025”, “29 Aug 2025”, dd-mm-yyyy, dd/mm/yyyy, or yyyy-mm-dd
    let expense_date = (parsed.expense_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
      const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
      let d = null;

      const long = rawText.match(/\b(\d{1,2})\s+([A-Za-z]{3,})[a-z]*\s+(\d{4})\b/); // 29 August 2025 / 29 Aug 2025
      if (long) {
        const day = Number(long[1]);
        const mon = months[long[2].slice(0,3).toLowerCase()];
        const yr  = Number(long[3]);
        if (mon) d = new Date(Date.UTC(yr, mon - 1, day));
      }

      const dmy = rawText.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/); // 29-08-2025 / 29/08/2025
      if (!d && dmy) d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));

      const iso = rawText.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); // 2025-08-29
      if (!d && iso) d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

      if (d && !isNaN(d)) expense_date = d.toISOString().slice(0,10);
    }
    if (!expense_date) expense_date = today;

    // Category: quick merchant keyword hints if model returned Other
    let category = parsed.category || 'Other';
    if (category === 'Other') {
      const lower = rawText.toLowerCase();
      if (/\b(bakery|baking|cafe|restaurant|hotel|food|eatery)\b/.test(lower)) category = 'Food & Dining';
      else if (/\b(petrol|diesel|fuel)\b/.test(lower)) category = 'Fuel';
      else if (/\b(uber|ola|cab|bus|train|metro|transport)\b/.test(lower)) category = 'Transport';
      else if (/\b(amazon|flipkart|myntra|shopping)\b/.test(lower)) category = 'Shopping';
      else if (/\b(rent)\b/.test(lower)) category = 'Rent';
      else if (/\b(electric|internet|wifi|bills?)\b/.test(lower)) category = 'Bills & Utilities';
      else if (/\b(netflix|spotify|prime|entertainment)\b/.test(lower)) category = 'Entertainment';
      else if (/\b(hospital|medicine|pharma|health)\b/.test(lower)) category = 'Health';
    }

    // Description: prefer "Paid to ..." or merchant-like line
    let description = (parsed.description || '').trim();
    if (!description) {
      const paidTo = rawText.match(/paid\s+to\s+(.+?)$/im);
      description = (paidTo?.[1] || '').trim().slice(0, 60);
      if (!description) description = 'Receipt import';
    }

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

  } catch (err) {
    return {
      statusCode: 500,
      body: `Server error: ${err?.message || err}`
    };
  }
};
