# StepBoard 🧑‍🏫✏️

An AI tutor that **talks and draws every step on a whiteboard**, built only with free tools.

It combines 3 free AIs:

| Job | Default AI | Why |
|---|---|---|
| 🧠 **Planner** (thinks + solves privately first) | Gemini | Smart, and it can read photos of homework |
| ✏️ **Teacher** (turns the plan into talk + drawings) | Groq | Super fast |
| 🛟 **Backup** for both | OpenRouter (free models) | Takes over if the others hit their limit |

If one AI fails, the next one in line takes over automatically.

---

## 1. Get your free keys (5 minutes)

You need **at least one**. Gemini is the most important (it's the only one that reads photos).

1. **Gemini** → https://aistudio.google.com/apikey
2. **Groq** → https://console.groq.com/keys
3. **OpenRouter** → https://openrouter.ai/keys

## 2. Run it on your computer

You need **Node.js 18 or newer** (https://nodejs.org).

```bash
cd stepboard
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Open `.env`, paste your keys, then:

```bash
npm start
```

Open **http://localhost:3000** 🎉

## 3. Put it online for free (so your friends can use it)

Use **Render** (free plan):

1. Upload the `stepboard` folder to a GitHub repo. **Do NOT upload your `.env` file** (the included `.gitignore` blocks it).
2. On https://render.com → New → **Web Service** → pick your repo.
3. Build command: `npm install` · Start command: `npm start`
4. Under **Environment**, add the same keys from your `.env` (and set `APP_PASSWORD` so strangers can't use up your limits).

Note: Render's free plan "sleeps" when nobody uses it, so the first visit can take ~30–60 seconds to wake up.

---

## How it works (the simple version)

```
You ask ──► server.js
              │
              ├─ 1. PLANNER AI writes private teacher's notes
              │     (problem, full solution, common mistakes, teaching plan)
              │
              └─ 2. TEACHER AI turns the notes into JSON steps:
                    { "say": "...", "draw": [ shapes ] }
                          │
public/app.js ◄───────────┘
   for each step: speak the "say" + draw the shapes, one by one
```

**Graphs are calculated by the app (math.js)**, not drawn by the AI, so curves are always accurate.

## Files

```
stepboard/
├── server.js          ← the brain: talks to the AIs, hides your keys, holds the prompts
├── .env.example       ← copy to .env and add keys
├── package.json
└── public/
    ├── index.html     ← the page
    ├── style.css      ← the look
    └── app.js         ← the whiteboard, voice, mic, quiz
```

## Things to tweak

- **Better lessons** → edit `plannerPrompt` and `teacherPrompt` in `server.js`. This is where most of the quality comes from.
- **Swap which AI does which job** → `PLANNER_ORDER` / `TEACHER_ORDER` in `.env`.
- **New shape types** (e.g. tables, triangles) → add a `case` in `drawShape()` in `app.js`, and describe it in `teacherPrompt`.

## If something breaks

| Problem | Fix |
|---|---|
| "No AI keys found" | Check `.env` is named exactly `.env` and is in the `stepboard` folder. Restart `npm start`. |
| "model not found" / 404 | Free model names change. Check the current list and update the `*_MODEL` line in `.env`: [Gemini](https://ai.google.dev/gemini-api/docs/models) · [Groq](https://console.groq.com/docs/models) · [OpenRouter free](https://openrouter.ai/models?q=free) |
| 429 errors | You hit a free daily limit. Add another provider's key so it can fall back. |
| No voice | Voice uses your browser's built-in voices. Chrome/Edge work best. Amharic usually has no built-in voice, so it shows subtitles instead. |
| Mic button missing | Your browser doesn't support speech input (works in Chrome/Edge). |
| Drawings overlap | The AI sometimes places things badly. Press **Replay** or ask again; or tighten the layout rules in `teacherPrompt`. |
