const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const MAX_TEXT_LENGTH = 8000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });
}

function getClientIp(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function checkLimit(request) {
  const guestLimit = Number(process.env.GUEST_DAILY_LIMIT || 10);
  const userLimit = Number(process.env.USER_DAILY_LIMIT || 50);
  const authHeader = request.headers.get('authorization') || '';
  const subject = authHeader.startsWith('Bearer ')
    ? `user:${authHeader.slice(7, 23)}`
    : `guest:${getClientIp(request)}`;
  const limit = authHeader.startsWith('Bearer ') ? userLimit : guestLimit;

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return { allowed: true, remaining: null, limit };
  }

  const { kv } = await import('@vercel/kv');
  const key = `receipt-parser:${dayKey()}:${subject}`;
  const current = await kv.incr(key);

  if (current === 1) {
    await kv.expire(key, 60 * 60 * 36);
  }

  return {
    allowed: current <= limit,
    remaining: Math.max(limit - current, 0),
    limit,
  };
}

function buildPrompt(text) {
  return [
    {
      role: 'system',
      content:
        'You extract expense data from OCR receipt text. Return only valid JSON with keys: amount, shop, category, date. amount must be a number or null. shop, category, date must be strings or null. date must use YYYY-MM-DD when present.',
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

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return json(204, {});
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  if (!process.env.GROQ_API_KEY) {
    return json(500, { error: 'GROQ_API_KEY is not configured' });
  }

  const limit = await checkLimit(request);
  if (!limit.allowed) {
    return json(429, {
      error: 'Daily receipt parsing limit reached',
      limit: limit.limit,
      remaining: limit.remaining,
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return json(400, { error: 'Missing text field' });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return json(413, { error: `Text is too long. Max ${MAX_TEXT_LENGTH} characters.` });
  }

  const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
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
    return json(groqResponse.status, {
      error: 'Groq request failed',
      details: groqBody?.error?.message || 'Unknown Groq error',
    });
  }

  try {
    const content = groqBody.choices?.[0]?.message?.content || '{}';
    const parsed = parseGroqJson(content);

    return json(200, {
      amount: parsed.amount ?? null,
      shop: parsed.shop ?? null,
      category: parsed.category ?? null,
      date: parsed.date ?? null,
      remaining: limit.remaining,
    });
  } catch {
    return json(502, { error: 'Failed to parse Groq response' });
  }
}
