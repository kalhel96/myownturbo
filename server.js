// =============================================================
//  StepBoard server
//  - Hides your API keys (the browser never sees them)
//  - Combines several FREE AIs:
//      PLANNER  = thinks first and writes private "teacher's notes"
//      TEACHER  = turns those notes into talk + drawing steps (JSON)
//    If one AI fails or hits its limit, the next one takes over.
// =============================================================
import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json({ limit: "15mb" })); // photos are sent as base64 text
app.use(express.static("public"));
// serve the math library from our own server (no CDN needed)
app.use("/vendor", express.static("node_modules/mathjs/lib/browser"));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || "";

const ORDER = {
  planner: (process.env.PLANNER_ORDER || "gemini,groq,openrouter").split(",").map((s) => s.trim()),
  teacher: (process.env.TEACHER_ORDER || "groq,gemini,openrouter").split(",").map((s) => s.trim()),
};

// -------------------------------------------------------------
//  1. THE AI PROVIDERS
//  Every provider gets the same input:
//    { system, messages: [{ role, text, image? }], json }
//  and returns plain text.
// -------------------------------------------------------------

// Google Gemini has its own request format
const gemini = {
  name: "Gemini",
  enabled: () => !!process.env.GEMINI_API_KEY,
  vision: true,
  async call({ system, messages, json }) {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const contents = messages.map((m) => {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      if (m.image) parts.push({ inline_data: { mime_type: m.image.mime, data: m.image.data } });
      return { role: m.role === "assistant" ? "model" : "user", parts };
    });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.4, ...(json ? { responseMimeType: "application/json" } : {}) },
        }),
      }
    );
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) throw new Error("empty answer");
    return text;
  },
};

// Groq and OpenRouter both copy OpenAI's format, so one helper covers both
function openAIStyle({ name, url, keyEnv, modelEnv, defaultModel, visionEnv, jsonMode }) {
  return {
    name,
    enabled: () => !!process.env[keyEnv],
    vision: process.env[visionEnv] === "true",
    async call({ system, messages, json }) {
      const send = async (useJsonMode) => {
        const body = {
          model: process.env[modelEnv] || defaultModel,
          temperature: 0.4,
          messages: [
            { role: "system", content: system },
            ...messages.map((m) => ({
              role: m.role,
              content: m.image
                ? [
                    { type: "text", text: m.text || "Here is my image." },
                    { type: "image_url", image_url: { url: `data:${m.image.mime};base64,${m.image.data}` } },
                  ]
                : m.text,
            })),
          ],
        };
        if (useJsonMode) body.response_format = { type: "json_object" };
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env[keyEnv]}` },
          body: JSON.stringify(body),
        });
      };

      let res = await send(json && jsonMode);
      // Some models don't support "JSON mode" — try again without it
      if (res.status === 400 && json && jsonMode) res = await send(false);
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      if (!text) throw new Error("empty answer");
      return text;
    },
  };
}

const providers = {
  gemini,
  groq: openAIStyle({
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    defaultModel: "openai/gpt-oss-120b",
    visionEnv: "GROQ_VISION",
    jsonMode: true,
  }),
  openrouter: openAIStyle({
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    keyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    visionEnv: "OPENROUTER_VISION",
    jsonMode: false, // many free models don't support it; we clean up the reply ourselves
  }),
};

// -------------------------------------------------------------
//  2. THE "TRY THE NEXT AI" CHAIN
// -------------------------------------------------------------
async function ask(order, { system, messages, json = false, validate }) {
  const needsVision = messages.some((m) => m.image);
  const errors = [];

  for (const id of order) {
    const p = providers[id];
    if (!p || !p.enabled()) continue;
    if (needsVision && !p.vision) continue;
    try {
      const text = await p.call({ system, messages, json });
      if (!json) return { data: text.trim(), by: p.name };
      const obj = parseJSON(text);
      if (validate && !validate(obj)) throw new Error("reply was missing lesson steps");
      return { data: obj, by: p.name };
    } catch (e) {
      console.warn(`[${p.name}] failed: ${e.message}`);
      errors.push(`${p.name}: ${e.message}`);
    }
  }

  if (!errors.length) {
    throw new Error(
      needsVision
        ? "No AI that can read photos is set up. Add a GEMINI_API_KEY in your .env file."
        : "No AI keys found. Add at least one key in your .env file."
    );
  }
  throw new Error("Every AI failed. " + errors.join(" | "));
}

// AIs sometimes wrap JSON in ```code fences``` or add chatter. Dig the JSON out.
function parseJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON in reply");
  return JSON.parse(text.slice(start, end + 1));
}

// -------------------------------------------------------------
//  3. THE PROMPTS (this is the "secret sauce" — tweak freely)
// -------------------------------------------------------------
const MODE_RULES = {
  explain:
    "Teach the idea fully so it truly clicks. Build intuition first, then details. Use a visual on almost every step.",
  homework:
    "This is homework. NEVER give the final answer outright. Give one small hint or step at a time, then ask the student to try the next step. If the student answers, check it: praise what is right and gently fix what is wrong. Only confirm the final answer after the student reaches it.",
  exam:
    "The student is preparing for a test, often from their own notes or study guide. Walk through each key point briefly, point out classic traps and common mistakes, and finish with a quiz on the trickiest parts.",
};

function plannerPrompt(mode, language) {
  return `You are an expert, patient tutor. Before teaching, you write PRIVATE teacher's notes. The student never sees these notes.

Write these sections in plain text:
1. PROBLEM: exactly what the student is asking. If there is an image, carefully copy out everything in it (numbers, equations, labels).
2. SOLUTION: a fully worked, correct solution or explanation. Double-check every calculation.
3. LIKELY MISTAKES: where students usually get confused here.
4. TEACHING PLAN: 3 to 7 short steps. For each step: what to say and what to draw (graph, diagram, labeled arrows, table, equation).
5. STUDENT CHECK: if this is a follow-up message, what the student just said, whether it is correct, and how to respond.

Mode rules: ${MODE_RULES[mode] || MODE_RULES.explain}
The lesson will be taught in ${language}. Keep the notes concise.`;
}

function teacherPrompt(mode, language) {
  const ending =
    mode === "homework"
      ? `Homework mode: do NOT reveal the final answer unless the notes say the student already reached it. End the last step by asking the student a question. Make "quiz" an empty list [].`
      : `End with a "quiz" of 2 or 3 multiple-choice questions on the trickiest ideas. "answer" is the index of the correct choice, starting at 0.`;

  return `You are a friendly tutor who talks while drawing on a whiteboard. Turn the teacher's notes into a lesson.
Reply with ONLY a JSON object, no other text, in exactly this shape:

{
  "title": "short lesson title",
  "clearBoard": true,
  "steps": [
    { "say": "One or two short spoken sentences.", "draw": [ shapes... ] }
  ],
  "quiz": [ { "q": "question", "choices": ["A", "B", "C"], "answer": 0 } ]
}

THE BOARD is 800 wide and 500 tall. (0,0) is the top-left corner. y grows DOWNWARD.

SHAPES you can draw:
- {"type":"text","x":40,"y":60,"text":"Short words","size":28,"color":"black","bold":false,"align":"left"}   (y is the bottom of the letters; align is "left" or "center")
- {"type":"line","x1":40,"y1":100,"x2":300,"y2":100,"color":"gray"}
- {"type":"arrow","x1":100,"y1":150,"x2":100,"y2":300,"color":"red"}   (the arrowhead is at x2,y2)
- {"type":"circle","x":200,"y":200,"r":30,"color":"blue","fill":false}
- {"type":"rect","x":50,"y":50,"w":200,"h":100,"color":"green"}
- {"type":"graph","x":420,"y":60,"w":340,"h":260,"xmin":-5,"xmax":5,"ymin":-2,"ymax":10,
   "fns":[{"fn":"x^2","color":"blue","label":"y = x^2"}],
   "points":[{"x":-1,"y":1,"label":"A(-1, 1)"}],
   "title":"optional title"}
  "fn" uses x as the variable in normal math syntax: x^2, 2*x + 3, sin(x), sqrt(x), exp(x), log(x).
  The app calculates the curve for you, so never plot curves by hand with lines.

COLORS: black, blue, red, green, orange, purple, gray.

RULES:
- 3 to 8 steps. Each "say" is 1 or 2 short, natural sentences, like a real tutor talking out loud.
- Every step should draw something that matches what is being said.
- Plan the layout so NOTHING overlaps: words and equations on the left, graphs and diagrams on the right, moving down the board step by step. Text size 22 to 32. Keep board text short.
- Use a graph for anything about functions or data. Use arrows and labels for forces, processes and cause-and-effect.
- Write "say", board text and the quiz in ${language}. Keep math symbols as they are.
- If "clearBoard" is false, your drawings are ADDED to what is already on the board, so only use the empty space below the used area. If there is not enough room, set "clearBoard" to true.
- ${ending}
- Follow the teacher's notes. They are correct.`;
}

// -------------------------------------------------------------
//  4. THE API ROUTE THE WEB PAGE CALLS
// -------------------------------------------------------------
app.post("/api/lesson", async (req, res) => {
  if (APP_PASSWORD && req.get("x-app-password") !== APP_PASSWORD) {
    return res.status(401).json({ error: "Wrong password" });
  }

  try {
    const {
      question = "",
      image = null,
      mode = "explain",
      language = "English",
      history = [],
      notes: oldNotes = "",
      boardBottom = 0,
    } = req.body || {};

    if (!String(question).trim() && !image) return res.status(400).json({ error: "Ask something first." });

    const cleanHistory = (Array.isArray(history) ? history : [])
      .filter((h) => h && typeof h.text === "string" && (h.role === "user" || h.role === "assistant"))
      .slice(-12)
      .map((h) => ({ role: h.role, text: h.text.slice(0, 4000) }));
    const isNewLesson = cleanHistory.length === 0;

    // ---- Step A: PLANNER thinks first (private notes) ----
    const latest = {
      role: "user",
      text:
        (oldNotes ? `(Your earlier private notes, for context:\n${String(oldNotes).slice(0, 4000)})\n\n` : "") +
        `Student: ${question || "(The student sent a photo. Work out what they need help with.)"}`,
      image: image?.data ? { mime: image.mime || "image/jpeg", data: image.data } : undefined,
    };
    const plan = await ask(ORDER.planner, {
      system: plannerPrompt(mode, language),
      messages: [...cleanHistory, latest],
    });

    // ---- Step B: TEACHER turns the notes into board steps ----
    const convo = cleanHistory.map((h) => `${h.role === "user" ? "Student" : "Tutor"}: ${h.text}`).join("\n");
    const used = Math.round(Number(boardBottom) || 0);
    const teacherInput =
      `TEACHER'S NOTES:\n${plan.data}\n\n` +
      `CONVERSATION SO FAR:\n${convo || "(new lesson)"}\n\n` +
      `STUDENT'S NEW MESSAGE: ${question || "(sent a photo)"}\n\n` +
      `BOARD: ${isNewLesson || used <= 0 ? "empty." : `already used from the top down to y=${used}.`}`;

    const lesson = await ask(ORDER.teacher, {
      system: teacherPrompt(mode, language),
      messages: [{ role: "user", text: teacherInput }],
      json: true,
      validate: (v) => Array.isArray(v?.steps) && v.steps.length > 0,
    });

    res.json({
      title: lesson.data.title || "Lesson",
      clearBoard: isNewLesson ? true : lesson.data.clearBoard !== false,
      steps: lesson.data.steps,
      quiz: Array.isArray(lesson.data.quiz) ? lesson.data.quiz : [],
      notes: plan.data,
      by: { planner: plan.by, teacher: lesson.by },
    });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  const ready = Object.values(providers).filter((p) => p.enabled()).map((p) => p.name);
  console.log(`\n✅ StepBoard running → http://localhost:${PORT}`);
  console.log(ready.length ? `🧠 AIs ready: ${ready.join(", ")}` : "⚠️  No AI keys found. Fill in your .env file!");
});
