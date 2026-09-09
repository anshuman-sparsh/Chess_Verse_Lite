# Chess Verse Lite

Chess Verse Lite is a lightweight, responsive chess game reviewer. PGN parsing and Stockfish analysis run locally in the browser. The optional AI Coach sends only a compact, structured summary of completed engine analysis through a server-side proxy when the user explicitly requests a report.

Live app: [chess-verse-lite.vercel.app](https://chess-verse-lite.vercel.app/)

## Features

- Load standard PGNs or games that use `SetUp` and `FEN` headers.
- Review every mainline move with a reusable Web Worker running bundled Stockfish.
- Compare White/Black accuracy and inspect move classifications, best moves, and principal variations.
- Explore variations in Practice Mode using click-to-move or drag-and-drop, including underpromotion choices.
- Generate an optional, cached AI Coach explanation after Stockfish analysis completes.
- Use keyboard navigation and a responsive dark/glassmorphic interface.

## Analysis semantics

Engine scores are stored as tagged values instead of overloading large centipawn numbers:

- `{ type: "cp", whitePovCp }`
- `{ type: "mate", winner, moves }`
- `{ type: "terminal", result: "draw" }`

Centipawn scores are normalized to White's point of view exactly once when Stockfish output is parsed. The displayed evaluation bar is also White POV.

Win probability uses the logistic function below, with centipawns clamped to `[-1000, 1000]` for numerical stability:

```text
Wwhite(cp) = 100 / (1 + exp(-0.00368208 * cp))
```

For each move, both before/after probabilities are converted to the mover's point of view. Win-probability loss is `max(0, Wbefore - Wafter)`. Per-move accuracy is:

```text
accuracy = 100 * exp(-0.035 * winProbabilityLoss)
```

Both values are clamped to `[0, 100]`. Player accuracy is the arithmetic mean of all available moves by that player, including short games. If a side made no move, its value is shown as unavailable rather than `0%`.

Classifications use mover-POV win-probability loss: Best `<= 0.5`, Excellent `<= 1.5`, Good `<= 3`, Inaccuracy `<= 7`, Mistake `<= 15`, and Blunder above `15` percentage points. The exact engine move is always Best unless stronger, independently verified evidence exists. A Miss requires a failed decisive opportunity (or losing a forced mate), not merely a large ordinary loss. Book is emitted only from explicit book evidence. Great and Brilliant require evidence fields for uniqueness/non-obviousness or a sound persistent sacrifice; the current single-PV analyzer intentionally does not invent that evidence, so it conservatively avoids those labels.

These formulas are application heuristics, not official Chess.com or Lichess formulas. Changing them will change historical accuracy and classification output.

## Safety and limits

- One Stockfish worker is reused across searches.
- Reset, mode switch, cancellation, or a new game invalidates the current analysis session.
- Searches have readiness, search, and stop-drain timeouts. A worker that cannot stop cleanly is replaced.
- Only exact primary-PV scores are accepted; bound scores and other MultiPV lines are ignored.
- PGN input is limited to 100,000 characters and games to 400 plies to protect low-memory/mobile devices.

## AI Coach architecture

```text
Browser analysis data → POST /api/coach → Vercel Function → Gemini API
```

Stockfish remains the chess authority. Gemini receives classifications, mover-POV probability loss, compact move signals, and at most eight detailed critical moments. Gemini returns explanatory prose only; the application merges it with server-validated Stockfish moves, classifications, evaluations, probabilities, and lines. Requests, prose responses, sizes, and supported phase ratings are validated.

Reports are generated only after an explicit click. Valid reports are cached in IndexedDB using the canonical game hash, analysis schema version, and coach schema version. Re-analyzing the same game can reuse the saved report without another API call.

The client never receives the Gemini API key or provider URL. The public code communicates only with `/api/coach`.

## Run locally

Opening `index.html` directly may be blocked by browser Worker/WASM security rules. Serving the directory over HTTP is recommended:

```bash
python -m pip install -r requirements.txt
python run.py
```

Then open `http://localhost:5000`. Stockfish works through Flask, but the Vercel AI Coach function is available locally only when using `vercel dev` with local environment variables.

To explicitly enable Flask's development debugger, set `FLASK_DEBUG=1` in your local environment. Do not enable it in production.

## Tests

Node.js 18 or newer is sufficient; there are no npm runtime dependencies.

```bash
npm test
```

The regression suite covers chess.js PGN/FEN parsing, special moves, tagged score math, mover perspective, short games, mate/Miss behavior, conservative classification evidence, UCI readiness, worker reuse, cancellation, session changes, stale responses, coach payload/hash validation, response evidence integrity, caching, duplicate prevention, provider failures/timeouts, and endpoint security behavior. Tests use mocked Gemini responses and never make paid API calls.

## Deployment

The included Vercel configuration adds baseline browser security headers and a 30-second maximum duration for the coach function.

Configure these Vercel environment variables for Production, Preview, and Development as appropriate:

```text
GEMINI_API_KEY=<server-side secret>
GEMINI_MODEL=gemini-3.7-flash
GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite
```

Never prefix the secret with `VITE_`, `NEXT_PUBLIC_`, or another public-client prefix. Never commit `.env` files containing the key.
