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
      role: 'system',
      content:
        'You extract expense data from OCR receipt text. Return only valid JSON with keys: amount, shop, category, date, time. amount must be a number or null. shop, category, date, and time must be strings or null. date must use YYYY-MM-DD when present. time must use HH:mm in 24-hour format when present.',
    },
    {
      role: 'user',
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
