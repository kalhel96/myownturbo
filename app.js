// =============================================================
//  StepBoard front end
//  1) Sends your question to the server
//  2) Gets back "steps" = { say, draw[] }
//  3) For each step: speaks the words + draws the shapes
// =============================================================

const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const layer = $("layer");
const defs = $("defs");

const COLORS = {
  black: "#1f2937", blue: "#2563eb", red: "#dc2626", green: "#16a34a",
  orange: "#ea580c", purple: "#7c3aed", gray: "#9ca3af",
};
const SPEECH_LANG = {
  English: "en-US", Amharic: "am-ET", Spanish: "es-ES", French: "fr-FR",
  Arabic: "ar-SA", Chinese: "zh-CN", Hindi: "hi-IN",
};

// ---------- App memory (lives only while the page is open) ----------
let history = [];        // conversation: [{ role: "user" | "assistant", text }]
let lastNotes = "";      // planner's private notes from the last turn
let lastLesson = null;   // for Replay
let boardBottom = 0;     // how far down the board is used
let playToken = 0;       // changes every time we stop, so old playback quits
let attachedImage = null;
let busy = false;
let uid = 0;

// ---------- Small helpers ----------
function el(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
const colorOf = (c) => COLORS[c] || COLORS.black;
const colorName = (c) => (COLORS[c] ? c : "black");
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const track = (y) => { boardBottom = Math.max(boardBottom, y); };

// One arrowhead per color
for (const [name, hex] of Object.entries(COLORS)) {
  const m = el("marker", {
    id: `arrow-${name}`, viewBox: "0 0 10 10", refX: "8", refY: "5",
    markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse",
  });
  m.appendChild(el("path", { d: "M0,0 L10,5 L0,10 z", fill: hex }));
  defs.appendChild(m);
}

// =============================================================
//  DRAWING
// =============================================================

// Makes a line look like it's being drawn by a pen
function animateStroke(node, ms = 600) {
  if (!node.getTotalLength) return;
  let len = 0;
  try { len = node.getTotalLength(); } catch { return; }
  if (!len) return;
  node.style.strokeDasharray = len;
  node.style.strokeDashoffset = len;
  node.getBoundingClientRect(); // tells the browser "start from here"
  node.style.transition = `stroke-dashoffset ${ms}ms ease-out`;
  node.style.strokeDashoffset = 0;
}

function drawShape(s) {
  if (!s || typeof s !== "object") return;
  const c = colorOf(s.color);

  switch (s.type) {
    case "text":
      return drawText(s);

    case "line":
    case "arrow": {
      const x1 = num(s.x1), y1 = num(s.y1), x2 = num(s.x2), y2 = num(s.y2);
      const line = el("line", {
        x1, y1, x2, y2, stroke: c, "stroke-width": num(s.width, 3), "stroke-linecap": "round",
      });
      layer.appendChild(line);
      animateStroke(line);
      if (s.type === "arrow") {
        setTimeout(() => line.setAttribute("marker-end", `url(#arrow-${colorName(s.color)})`), 550);
      }
      track(Math.max(y1, y2));
      return;
    }

    case "circle": {
      const x = num(s.x, 400), y = num(s.y, 250), r = Math.max(1, num(s.r, 20));
      const circle = el("circle", {
        cx: x, cy: y, r, stroke: c, "stroke-width": 3,
        fill: s.fill ? c : "none", "fill-opacity": s.fill ? 0.25 : 0,
      });
      layer.appendChild(circle);
      animateStroke(circle);
      track(y + r);
      return;
    }

    case "rect": {
      const x = num(s.x), y = num(s.y), w = Math.max(1, num(s.w, 100)), h = Math.max(1, num(s.h, 60));
      const rect = el("rect", {
        x, y, width: w, height: h, rx: 6, stroke: c, "stroke-width": 3,
        fill: s.fill ? c : "none", "fill-opacity": s.fill ? 0.15 : 0,
      });
      layer.appendChild(rect);
      animateStroke(rect);
      track(y + h);
      return;
    }

    case "graph":
      return drawGraph(s);

    default:
      console.warn("Unknown shape type:", s.type);
  }
}

// Text with simple word-wrapping (SVG can't wrap on its own)
function drawText(s) {
  const size = Math.min(48, Math.max(12, num(s.size, 26)));
  const x = num(s.x, 30), y = num(s.y, 40);
  const center = s.align === "center";
  const maxWidth = center ? 760 : Math.max(80, 790 - x);
  const perLine = Math.max(6, Math.floor(maxWidth / (size * 0.48)));
  const lines = wrap(String(s.text ?? ""), perLine);

  const t = el("text", {
    x, y, fill: colorOf(s.color), "font-size": size,
    class: "hand fade" + (s.bold ? " bold" : ""),
    "text-anchor": center ? "middle" : "start",
  });
  lines.forEach((line, i) => {
    const span = el("tspan", { x, dy: i === 0 ? 0 : size * 1.15 });
    span.textContent = line;
    t.appendChild(span);
  });
  layer.appendChild(t);
  track(y + (lines.length - 1) * size * 1.15 + size * 0.3);
}

function wrap(text, maxChars) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const next = (current + " " + word).trim();
    if (next.length > maxChars && current) { lines.push(current); current = word; }
    else current = next;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// Picks a tidy grid spacing like 1, 2, 5, 10, 20...
function niceStep(range) {
  const raw = range / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

// Graphs are CALCULATED here (not guessed by the AI)
function drawGraph(s) {
  const gx = num(s.x, 420), gy = num(s.y, 60);
  const gw = Math.max(80, num(s.w, 340)), gh = Math.max(80, num(s.h, 260));
  let xmin = num(s.xmin, -5), xmax = num(s.xmax, 5);
  let ymin = num(s.ymin, -5), ymax = num(s.ymax, 5);
  if (xmax <= xmin) xmax = xmin + 10;
  if (ymax <= ymin) ymax = ymin + 10;

  // math coordinates → board coordinates
  const X = (v) => gx + ((v - xmin) / (xmax - xmin)) * gw;
  const Y = (v) => gy + gh - ((v - ymin) / (ymax - ymin)) * gh;

  // keep curves inside the graph box
  const clipId = `clip${++uid}`;
  const clip = el("clipPath", { id: clipId });
  clip.appendChild(el("rect", { x: gx, y: gy, width: gw, height: gh }));
  defs.appendChild(clip);

  const g = el("g", { class: "fade" });
  layer.appendChild(g);
  g.appendChild(el("rect", { x: gx, y: gy, width: gw, height: gh, fill: "#ffffff", stroke: "#d6d3c8", rx: 6 }));

  // grid + number labels
  const xs = niceStep(xmax - xmin), ys = niceStep(ymax - ymin);
  for (let v = Math.ceil(xmin / xs) * xs; v <= xmax + 1e-9; v += xs) {
    g.appendChild(el("line", { x1: X(v), y1: gy, x2: X(v), y2: gy + gh, stroke: "#f0ede4" }));
    const label = el("text", { x: X(v), y: gy + gh + 14, class: "small", "text-anchor": "middle" });
    label.textContent = +v.toFixed(6);
    g.appendChild(label);
  }
  for (let v = Math.ceil(ymin / ys) * ys; v <= ymax + 1e-9; v += ys) {
    g.appendChild(el("line", { x1: gx, y1: Y(v), x2: gx + gw, y2: Y(v), stroke: "#f0ede4" }));
    const label = el("text", { x: gx - 5, y: Y(v) + 4, class: "small", "text-anchor": "end" });
    label.textContent = +v.toFixed(6);
    g.appendChild(label);
  }

  // x and y axes (only if 0 is inside the view)
  if (ymin <= 0 && ymax >= 0) g.appendChild(el("line", { x1: gx, y1: Y(0), x2: gx + gw, y2: Y(0), stroke: "#6b7280", "stroke-width": 1.5 }));
  if (xmin <= 0 && xmax >= 0) g.appendChild(el("line", { x1: X(0), y1: gy, x2: X(0), y2: gy + gh, stroke: "#6b7280", "stroke-width": 1.5 }));

  if (s.title) {
    const t = el("text", { x: gx, y: gy - 8, class: "hand bold", "font-size": 22, fill: COLORS.black });
    t.textContent = s.title;
    g.appendChild(t);
  }

  // the curves
  const fns = Array.isArray(s.fns) ? s.fns : s.fn ? [{ fn: s.fn, color: s.color, label: s.label }] : [];
  const defaultColors = ["blue", "red", "green", "purple", "orange"];
  const span = ymax - ymin;

  fns.forEach((f, i) => {
    let compiled;
    try {
      compiled = math.compile(String(f.fn).replace(/^\s*y\s*=\s*/i, ""));
    } catch {
      console.warn("Couldn't understand function:", f.fn);
      return;
    }

    let d = "", penDown = false;
    const N = 300;
    for (let k = 0; k <= N; k++) {
      const xv = xmin + (k / N) * (xmax - xmin);
      let yv;
      try { yv = compiled.evaluate({ x: xv }); } catch { yv = NaN; }
      // lift the pen for gaps (like sqrt of negatives, or tan jumping)
      if (typeof yv !== "number" || !isFinite(yv) || yv < ymin - 3 * span || yv > ymax + 3 * span) {
        penDown = false;
        continue;
      }
      d += `${penDown ? "L" : "M"}${X(xv).toFixed(1)},${Y(yv).toFixed(1)} `;
      penDown = true;
    }
    if (!d) return;

    const c = colorOf(f.color || defaultColors[i % defaultColors.length]);
    const path = el("path", {
      d, fill: "none", stroke: c, "stroke-width": 3,
      "stroke-linejoin": "round", "clip-path": `url(#${clipId})`,
    });
    g.appendChild(path);
    animateStroke(path, 1000);

    if (f.label) {
      const lbl = el("text", { x: gx + 10, y: gy + 24 + i * 24, class: "hand bold", "font-size": 22, fill: c });
      lbl.textContent = f.label;
      g.appendChild(lbl);
    }
  });

  // dots with labels
  (Array.isArray(s.points) ? s.points : []).forEach((p) => {
    const px = num(p.x, NaN), py = num(p.y, NaN);
    if (!isFinite(px) || !isFinite(py)) return;
    if (px < xmin || px > xmax || py < ymin || py > ymax) return;
    g.appendChild(el("circle", { cx: X(px), cy: Y(py), r: 5, fill: colorOf(p.color || "red") }));
    if (p.label) {
      const t = el("text", { x: X(px) + 8, y: Y(py) - 8, class: "hand bold", "font-size": 20, fill: colorOf(p.color || "red") });
      t.textContent = p.label;
      g.appendChild(t);
    }
  });

  track(gy + gh + 18);
}

function clearBoard() {
  layer.innerHTML = "";
  defs.querySelectorAll("clipPath").forEach((c) => c.remove());
  boardBottom = 0;
}

// =============================================================
//  VOICE
// =============================================================
function pickVoice(langCode) {
  if (!("speechSynthesis" in window)) return null;
  const short = langCode.slice(0, 2).toLowerCase();
  return speechSynthesis.getVoices().find((v) => v.lang && v.lang.toLowerCase().startsWith(short)) || null;
}
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices(); // Chrome loads voices lazily
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

// Speaks the text. Resolves when finished (or after a safe timeout).
function speak(text) {
  return new Promise((resolve) => {
    if (!text) return resolve();
    const readingTime = Math.max(1500, text.length * 65);
    const langCode = SPEECH_LANG[$("language").value] || "en-US";
    const voice = pickVoice(langCode);

    // Voice off, not supported, or no voice for this language → just pause for reading
    if (!$("voiceOn").checked || !("speechSynthesis" in window) || !voice) {
      return setTimeout(resolve, readingTime);
    }

    const u = new SpeechSynthesisUtterance(text);
    u.lang = langCode;
    u.voice = voice;
    u.rate = 1.0;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    setTimeout(finish, readingTime + 5000); // safety net: some browsers forget "onend"
    speechSynthesis.speak(u);
  });
}

function stop() {
  playToken++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// =============================================================
//  PLAYING A LESSON (talk + draw, step by step)
// =============================================================
async function play(lesson, { fresh = false, bubble = null } = {}) {
  stop();
  const token = playToken;

  if (fresh || lesson.clearBoard) clearBoard();
  $("lessonTitle").textContent = lesson.title || "Lesson";
  $("quiz").innerHTML = "";

  for (const step of lesson.steps) {
    if (token !== playToken) return; // someone pressed Stop or asked something new

    const say = String(step.say || "");
    $("caption").textContent = say;
    if (bubble && say) {
      bubble.textContent += (bubble.textContent ? " " : "") + say;
      $("log").scrollTop = $("log").scrollHeight;
    }

    const talking = speak(say);
    for (const shape of Array.isArray(step.draw) ? step.draw : []) {
      if (token !== playToken) return;
      try { drawShape(shape); } catch (e) { console.warn("Couldn't draw:", shape, e); }
      await wait(500);
    }
    await talking;
    if (token !== playToken) return;
    await wait(250);
  }

  if (Array.isArray(lesson.quiz) && lesson.quiz.length) showQuiz(lesson.quiz);
}

// =============================================================
//  QUIZ
// =============================================================
function showQuiz(quiz) {
  const box = $("quiz");
  box.innerHTML = "<h3>Quick quiz</h3>";

  quiz.forEach((q, qi) => {
    if (!q || !Array.isArray(q.choices)) return;
    const card = document.createElement("div");
    card.className = "q";
    const p = document.createElement("p");
    p.textContent = `${qi + 1}. ${q.q}`;
    card.appendChild(p);

    const answer = Number(q.answer);
    const buttons = q.choices.map((choice, ci) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = choice;
      b.onclick = () => {
        buttons.forEach((x) => (x.disabled = true));
        const right = ci === answer;
        b.classList.add(right ? "right" : "wrong");
        buttons[answer]?.classList.add("right");
        if (!right) {
          const again = document.createElement("button");
          again.type = "button";
          again.className = "again";
          again.textContent = "🔁 Explain this one again";
          again.onclick = () =>
            askAI(`I got this quiz question wrong: "${q.q}". I picked "${choice}" but the answer is "${q.choices[answer]}". Explain why, in a different way.`);
          card.appendChild(again);
        }
      };
      card.appendChild(b);
      return b;
    });
    box.appendChild(card);
  });
}

// =============================================================
//  CHAT + TALKING TO THE SERVER
// =============================================================
function addLog(role, text, imgSrc) {
  $("ideas")?.remove();
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  if (imgSrc) {
    const img = document.createElement("img");
    img.src = imgSrc;
    d.appendChild(img);
  }
  const t = document.createElement("div");
  t.textContent = text;
  d.appendChild(t);
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
  return t;
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "error" : "";
}

async function api(url, body, retried = false) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-password": localStorage.getItem("appPassword") || "",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 && !retried) {
    const pw = prompt("Enter the app password:");
    if (!pw) throw new Error("Password needed.");
    localStorage.setItem("appPassword", pw);
    return api(url, body, true);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

async function askAI(text) {
  text = (text || "").trim();
  if (busy || (!text && !attachedImage)) return;

  stop(); // "cut in anytime": a new question stops the current lesson
  busy = true;
  $("sendBtn").disabled = true;
  setStatus("🧠 Thinking it through, then drawing…");

  const image = attachedImage;
  addLog("user", text || "(photo)", image?.preview);
  $("input").value = "";
  clearAttachment();

  try {
    const lesson = await api("/api/lesson", {
      question: text,
      image: image ? { mime: image.mime, data: image.data } : null,
      mode: $("mode").value,
      language: $("language").value,
      history: history.slice(-12),
      notes: lastNotes,
      boardBottom: Math.round(boardBottom),
    });

    // Only save to history after success (keeps user/assistant turns in order)
    history.push({ role: "user", text: text || "(sent a photo)" });
    history.push({ role: "assistant", text: lesson.steps.map((s) => s.say).join(" ") });
    lastNotes = lesson.notes || "";
    lastLesson = lesson;

    $("aiBadge").textContent = `🧠 Planned by ${lesson.by.planner} · ✏️ Taught by ${lesson.by.teacher}`;
    setStatus("");
    busy = false;
    $("sendBtn").disabled = false;

    const bubble = addLog("assistant", "");
    await play(lesson, { bubble });
  } catch (e) {
    setStatus("⚠️ " + e.message, true);
  } finally {
    busy = false;
    $("sendBtn").disabled = false;
  }
}

// =============================================================
//  PHOTOS (shrunk before sending so free limits last longer)
// =============================================================
function shrinkImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(img.src);
      resolve({ mime: "image/jpeg", data: url.split(",")[1], preview: url });
    };
    img.onerror = () => reject(new Error("Couldn't read that image."));
    img.src = URL.createObjectURL(file);
  });
}

function clearAttachment() {
  attachedImage = null;
  $("attachPreview").innerHTML = "";
}

$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    attachedImage = await shrinkImage(file);
    $("attachPreview").innerHTML = `<img src="${attachedImage.preview}" alt="Attached photo"><button type="button" id="removeImg" title="Remove">✕</button>`;
    $("removeImg").onclick = clearAttachment;
  } catch (err) {
    setStatus("⚠️ " + err.message, true);
  }
});

// =============================================================
//  MICROPHONE (speak your question)
// =============================================================
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Recognition) {
  $("micBtn").style.display = "none";
} else {
  $("micBtn").onclick = () => {
    stop();
    const r = new Recognition();
    r.lang = SPEECH_LANG[$("language").value] || "en-US";
    r.interimResults = false;
    $("micBtn").classList.add("listening");
    setStatus("🎤 Listening…");
    r.onresult = (e) => {
      const said = e.results[0][0].transcript;
      setStatus("");
      askAI(said);
    };
    r.onerror = () => setStatus("🎤 Didn't catch that. Try again or type.", true);
    r.onend = () => $("micBtn").classList.remove("listening");
    r.start();
  };
}

// =============================================================
//  BUTTONS
// =============================================================
$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  askAI($("input").value);
});

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    askAI($("input").value);
  }
});

$("stopBtn").onclick = stop;
$("replayBtn").onclick = () => { if (lastLesson) play(lastLesson, { fresh: true }); };
$("clearBtn").onclick = () => { stop(); clearBoard(); };
$("newBtn").onclick = () => {
  stop();
  clearBoard();
  history = [];
  lastNotes = "";
  lastLesson = null;
  $("log").innerHTML = "";
  $("quiz").innerHTML = "";
  $("caption").textContent = "";
  $("aiBadge").textContent = "";
  $("lessonTitle").textContent = "Ask anything to start";
  setStatus("");
};

document.querySelectorAll(".ideas button").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.mode) $("mode").value = b.dataset.mode;
    askAI(b.dataset.q);
  };
});
