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

    // Ask OpenAI Vision to extract expense info
    const prompt = `
You are a finance assistant. Read the receipt/bill screenshot and return a single JSON object with:
- amount (number, in INR if currency not visible),
- expense_date (yyyy-mm-dd, use today's date if unknown),
- category (one of: Groceries, Food & Dining, Fuel, Transport, Rent, Bills & Utilities, Shopping, Entertainment, Health, Other),
- description (short, 3-6 words).

Return ONLY JSON.`;

    const today = new Date().toISOString().slice(0,10);

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: `Today is ${today}. Extract fields.` },
              { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` }
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

    // Try to parse JSON from the model
    let parsed;
    try {
      const content = data.choices?.[0]?.message?.content || '{}';
      parsed = JSON.parse(content);
    } catch (_) {
      parsed = {};
    }

    // Minimal normalization & defaults
    const amount = Number(parsed.amount || 0);
    const expense_date = (parsed.expense_date || today).slice(0,10);
    const category = parsed.category || 'Other';
    const description = parsed.description || 'Receipt import';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memberName,
        amount,
        expense_date,
        category,
        currency: 'INR',
        description,
        source: 'image'
      })
    };
  } catch (e) {
    return { statusCode: 500, body: `Server error: ${e.message}` };
  }
};
