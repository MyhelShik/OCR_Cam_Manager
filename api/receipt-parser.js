const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const MAX_TEXT_LENGTH = 8000;

function preprocessOcrText(ocrText) {
  const ivaStart = ocrText.search(/Total\s*L[ií]q\.?/i);
  if (ivaStart !== -1) {
    ocrText = ocrText.substring(0, ivaStart);
  }
  
  const lines = ocrText.split('\n');
  const filteredLines = lines.filter(line => {
    return !/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s+\d{4}\b/i.test(line);
  });
  ocrText = filteredLines.join('\n');
  
  return ocrText;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.end(JSON.stringify(body));
}

function buildPrompt(processedText) {
  return [
    {
      role: "system",
      content: `You are a strict receipt parser. Return ONLY valid JSON with keys: amount, shop, category, date, time.

RULES:
1. AMOUNT:
   - Find "TOTAL A PAGAR". The amount is the number immediately after or in the same vertical block.
   - Validate: if cash ("Numerário" minus "TROCO") = amount. If card ("Cartao Credito") -> amount = sum of item prices.
2. SHOP:
   - "CONTINENTE" -> "Continente". Remove noise.
3. CATEGORY:
   - Section header above items: "Padaria:", "Soft Drinks:", "Mercearia:" etc. Map "Soft Drinks" -> "Bebidas".
4. DATE & TIME:
   - Look for pattern "DD/MM/YYYY HH:MM" (e.g., "02/06/2026 12:24"). Use that. Ignore any other dates.

OUTPUT ONLY JSON.`,
    },
    {
      role: "user",
      content: `Receipt OCR text (cleaned):\n${text}`,
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

let processedText = preprocessOcrText(text);

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
        messages: buildPrompt(preprocessOcrText(text)),
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
