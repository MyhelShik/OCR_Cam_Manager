const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const MAX_TEXT_LENGTH = 8000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.end(JSON.stringify(body));
}

function buildPrompt(text) {
  return [
    {
      role: "system",
      content: `You are a strict receipt parser. Return ONLY valid JSON with keys: amount, shop, category, date, time.

RULES:

1. AMOUNT (number or null):
   - Find label "TOTAL A PAGAR" (case‑insensitive).
   - The total is the number associated with it. If the number is not on the same line, look in the same column among numbers below (before the VAT breakdown lines like "Total Liq.", "IVA", "VALOR").
   - MANDATORY VALIDATION (choose method based on payment method):
     a) If payment is cash ("Numerário"/"Dinheiro"): find "TROCO" → total = paid - change.
     b) If payment is card ("Cartão Crédito"/"Cartao Credito"/"MB"/"Multibanco"): total must equal the sum of item lines.
   - NEVER take a number from lines containing: "Total Liq.", "IVA", "VALOR", "%IVA", "XIVA", "Total" (alone), "Subtotal".
   - If validation fails, try the largest number that appears near "TOTAL A PAGAR" but not in the VAT table.

2. SHOP:
   - If "CONTINENTE" → "Continente". Also handle "PINGO DOCE", "LIDL", "AUCHAN", "MERCADONA", "ALDI", "INTERMARCH".

3. CATEGORY:
   - Find section headers ("Mercearia:", "Padaria:", "Soft Drinks:", "Talho:", etc.).
   - Sum the item values under each section (items often have price lines like "2 X 0,99" or "1,49").
   - Choose the section with the highest sum.
   - Mapping: "Soft Drinks" → "Bebidas", "Mercearia" → "Mercearia", "Padaria" → "Padaria", etc.

4. DATE & TIME:
   - Look for a line containing a pattern like "DD/MM/YYYY HH:MM" (e.g., "12/06/2026 15:05").
   - That is the correct date and time. Ignore other dates/times (e.g., later lines like "12 June 2026 16:41").
   - Date format: DD/MM/YYYY → YYYY-MM-DD. Time: HH:MM (24h).

5. NUMBER FORMAT:
   - European: comma as decimal (1,84 → 1.84). Normalize spaces inside numbers ("1, 84" → "1,84").

OUTPUT ONLY JSON. NO EXTRA TEXT.`,
    },
    {
      role: "user",
      content: `Receipt OCR text:\n${text}`,
    },
  ];
}

function parseGroqJson(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(jsonText);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (!process.env.GROQ_API_KEY) {
    return send(res, 500, { error: 'GROQ_API_KEY is not configured' });
  }

  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return send(res, 400, { error: 'Missing text field' });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return send(res, 413, {
      error: `Text is too long. Max ${MAX_TEXT_LENGTH} characters.`,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: buildPrompt(text),
      }),
    });

    const groqBody = await groqResponse.json().catch(() => null);
    if (!groqResponse.ok) {
      return send(res, groqResponse.status, {
        error: 'Groq request failed',
        details: groqBody?.error?.message || 'Unknown Groq error',
      });
    }

    const content = groqBody?.choices?.[0]?.message?.content || '{}';
    const parsed = parseGroqJson(content);

    return send(res, 200, {
      amount: parsed.amount ?? null,
      shop: parsed.shop ?? null,
      category: parsed.category ?? null,
      date: parsed.date ?? null,
      time: parsed.time ?? null,
    });
  } catch (error) {
    const message =
      error?.name === 'AbortError'
        ? 'Groq request timed out'
        : 'Failed to parse receipt';

    return send(res, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
}
