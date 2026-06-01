# OCR Cam Manager

Small Vercel API for Finance Manager receipt parsing.

The Flutter app sends OCR text to this endpoint. The endpoint keeps the Groq API key on the server side, calls Groq, and returns structured expense data.

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
  "time": "17:42"
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
```

## Deploy

```bash
npm install
npm run deploy
```

After deployment, uses the endpoint URL in Flutter:

```bash
flutter run --dart-define=RECEIPT_PARSER_URL=https://your-project.vercel.app/api/receipt-parser
```
