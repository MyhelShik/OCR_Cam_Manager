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

RULES (follow exactly):

1. AMOUNT:
   - Find "TOTAL A PAGAR". The correct total is the number that satisfies ONE of these:
     a) For cash: "Numerário" minus "TROCO".
     b) For card: "Cartão Crédito" amount equals sum of items.
     c) For voucher ("VALE SDR", "VALE OFERTA", "VALE"): the voucher amount should cover the total; then total = sum of items.
   - If no payment info, total = sum of item prices (each item price is a number after its description, often with "X" quantity).
   - NEVER take a number from lines containing: "Total Liq.", "IVA", "VALOR", "%IVA", "XIVA", "Total" (alone), "Subtotal".
   - Example of WRONG: in a receipt with "Total Liq. 1,74" and later "2,14" as final total, the correct total is 2,14.

2. ITEMS SUM VALIDATION (mandatory):
   - Find all item price numbers (they often appear in lines like "2 X 0,99" or just "1,49" alone, after item descriptions).
   - Sum them. If sum matches a candidate number within ±0.01, that candidate is correct.

3. SHOP:
   - If "CONTINENTE" -> "Continente". Similarly for other chains. Remove OCR garbage.

4. CATEGORY:
   - Look for section headers: "Mercearia:", "Padaria:", "Soft Drinks:", "Talho:", etc. Map: "Soft Drinks" -> "Bebidas", "Mercearia" -> "Mercearia", "Padaria" -> "Padaria".
   - Pick section with highest sum of its items.

5. DATE & TIME:
   - Find line with pattern "DD/MM/YYYY HH:MM" (e.g., "26/05/2026 16:37"). Use that. Ignore other dates.

EXAMPLE (this is a correct parsing of a similar receipt):
OCR text: "... TOTAL A PAGAR ... Numerário 5,00 ... TROCO 1,70 ... Total Liq. ... 1,71 ... 3,30 ..."
Correct JSON: {"amount": 3.30, "shop": "Continente", "category": "Padaria", "date": "2026-06-02", "time": "12:24"}

NOW PARSE THE FOLLOWING RECEIPT:`,
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
