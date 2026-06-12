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
`You are an expert receipt parser. Extract expense data from OCR text and return ONLY valid JSON with keys: amount, shop, category, date, time.

CRITICAL RULES:

1. AMOUNT (number or null):
   - Look for the FINAL TOTAL to pay. Common labels: "TOTAL A PAGAR" (PT), "TOTAL" (ES/FR/DE), "SUMMA" (SE), "TOTALE" (IT), "GRAND TOTAL" (EN).
   - NEVER take a number from the VAT/IVA breakdown area (lines with "Total Liq.", "IVA", "VALOR", "Base imponible", "Netto", "HT").
   - If the total is split across columns: match the label "TOTAL A PAGAR" with the number in the same vertical position among a block of bare numbers.
   - VALIDATE total (±0.01):
     A) Sum of "Numerário"/"Dinheiro"/"Cash" minus "TROCO"/"Change" ≈ total.
     B) Sum of item lines (marked (A),(B),(C),NS or lines ending with a price) ≈ total.
   - If validation fails, try the next candidate (largest number near the total label).

2. SHOP (string):
   - Normalize common chains:
     "CONTINENTE" → "Continente"
     "PINGO DOCE" → "Pingo Doce"
     "LIDL" → "Lidl"
     "AUCHAN"/"JUMBO" → "Auchan"
     "INTERMARCH" → "Intermarché"
     "MERCADONA" → "Mercadona"
     "ALDI" → "Aldi"
     "CARREFOUR" → "Carrefour"
   - Remove OCR garbage (e.g., "HIPERInE", "HIPERMERCADUS1").

3. CATEGORY (string or null):
   - Find section headers above items: "Padaria", "Soft Drinks"→"Bebidas", "Mercearia", "Talho", "Peixaria", "Frutas e Legumes", "Lacticínios", "Higiene", "Limpeza".
   - Pick the section with the highest total sum of its items.
   - If no section → null.

4. DATE (string "YYYY-MM-DD" or null):
   - European format: DD/MM/YYYY (majority of receipts). US format: MM/DD/YYYY only if store location suggests US.
   - For dates like "02/06/2026" in a Portuguese receipt → day=02, month=06.
   - Sanity check: if day > 12, it's definitely DD/MM.

5. TIME (string "HH:MM" or null):
   - Extract time from patterns like "12:24" or "14:05". Use 24-hour format.

IMPORTANT: Return ONLY the JSON object. No extra text.`,
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
