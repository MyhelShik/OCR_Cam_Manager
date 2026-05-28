# OCR Cam Manager

Small Vercel API for Finance Manager receipt parsing.

The Flutter app sends OCR text to this endpoint. The endpoint keeps the Groq API key on the server side, applies a lightweight daily limit, calls Groq, and returns structured expense data.

## Endpoint

```text
POST /api/receipt-parser
```

Request:

```json
{
  "text": "receipt OCR text"
}
```

Response:

```json
{
  "amount": 12.5,
  "shop": "Continente",
  "category": "Food",
  "date": "2026-05-28",
  "remaining": 9
}
```

## Environment Variables

Required:

```text
GROQ_API_KEY=...
```

Optional:

```text
GROQ_MODEL=llama-3.1-8b-instant
GUEST_DAILY_LIMIT=10
USER_DAILY_LIMIT=50
```
4
If Vercel KV is connected to the project, the endpoint uses it for daily limits. Without KV, parsing still works, but rate limiting is skipped.

## Deploy

```bash
npm install
npm run deploy
```

After deployment, use the endpoint URL in Flutter:

```bash
flutter run --dart-define=RECEIPT_PARSER_URL=https://your-project.vercel.app/api/receipt-parser
```
