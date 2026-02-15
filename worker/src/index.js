/* ================= AUTH & RATE LIMITING ================= */
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;   // max 10 requests per minute per IP
const rateLimitMap = new Map();
let currentOrigin = ""; // set per request for CORS

function checkAuth(request, env) {
  if (!env.ACCESS_PASSWORD) {
    return jsonResponse({ error: "Server-Konfigurationsfehler." }, 500);
  }
  const authHeader = request.headers.get("X-Access-Password") || "";
  if (authHeader !== env.ACCESS_PASSWORD) {
    return jsonResponse({ error: "Nicht autorisiert. Falsches Passwort." }, 401);
  }
  return null; // auth OK
}

function checkRateLimit(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return null; // OK
  }

  const entry = rateLimitMap.get(ip);

  // Reset window if expired
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry.count = 1;
    entry.windowStart = now;
    return null; // OK
  }

  entry.count++;

  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return jsonResponse({
      error: "Zu viele Anfragen. Bitte warte eine Minute und versuche es erneut."
    }, 429);
  }

  return null; // OK
}

// Cleanup old entries periodically (every 100 requests)
let requestCounter = 0;
function cleanupRateLimitMap() {
  requestCounter++;
  if (requestCounter % 100 === 0) {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW * 5) {
        rateLimitMap.delete(ip);
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    currentOrigin = origin;

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      // Only protect /api/* routes
      if (pathname.startsWith("/api/")) {
        // 1. Auth check
        const authError = checkAuth(request, env);
        if (authError) return authError;

        // 2. Rate limit check
        const rateLimitError = checkRateLimit(request);
        if (rateLimitError) return rateLimitError;
        cleanupRateLimitMap();
      }

      if (pathname === "/api/verify" && request.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (pathname === "/api/generate" && request.method === "POST") {
        return await handleGenerate(request, env);
      }
      if (pathname === "/api/grade" && request.method === "POST") {
        return await handleGrade(request, env);
      }
      if (pathname === "/api/ocr" && request.method === "POST") {
        return await handleOCR(request, env);
      }
      if (pathname === "/api/parse-task" && request.method === "POST") {
        return await handleParseTask(request, env);
      }
      if (pathname === "/api/model-answer" && request.method === "POST") {
        return await handleModelAnswer(request, env);
      }
      // Dashboard endpoints
      if (pathname === "/api/submit-result" && request.method === "POST") {
        return await handleSubmitResult(request, env);
      }
      if (pathname === "/api/results" && request.method === "POST") {
        return await handleGetResults(request, env);
      }
      if (pathname === "/api/delete-result" && request.method === "POST") {
        return await handleDeleteResult(request, env);
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("API Error:", err.message);
      return new Response(
        JSON.stringify({ error: "Ein interner Fehler ist aufgetreten." }),
        { status: 500, headers: corsHeaders(origin) }
      );
    }
  }
};

/* ================= GENERATE ================= */
async function handleGenerate(request, env) {
  const body = await request.json();
  const { topic, source_len_words, prompt_template } = body;

  // Input validation
  if (!prompt_template || typeof prompt_template !== "string") {
    return jsonResponse({ error: "prompt_template ist erforderlich." }, 400);
  }
  if (prompt_template.length > 10000) {
    return jsonResponse({ error: "prompt_template ist zu lang." }, 400);
  }
  if (topic && typeof topic !== "string") {
    return jsonResponse({ error: "topic muss ein String sein." }, 400);
  }
  if (topic && topic.length > 500) {
    return jsonResponse({ error: "topic ist zu lang (max 500 Zeichen)." }, 400);
  }
  const wordLimit = parseInt(source_len_words) || 600;
  if (wordLimit < 100 || wordLimit > 2000) {
    return jsonResponse({ error: "source_len_words muss zwischen 100 und 2000 liegen." }, 400);
  }

  // Replace placeholders that the frontend couldn't resolve
  const safeTopic = (topic || "").trim();
  const prompt = prompt_template
    .replace(/\{topic\}/g, safeTopic)
    .replace(/\$\{topic\}/g, safeTopic)
    .replace(/\{length\}/g, String(wordLimit))
    .replace(/\$\{length\}/g, String(wordLimit));

  // Dynamic token limit: English text ~1.3 tokens/word + tasks + JSON overhead
  const wordTarget = source_len_words || 700;
  const estimatedTokens = Math.round(wordTarget * 1.5) + 1200; // article + tasks + JSON
  const maxTokens = Math.min(Math.max(estimatedTokens, 2500), 8000); // clamp between 2500-8000

  const openaiRes = await callOpenAI(env, [
    {
      role: "system",
      content: `You are an Abitur exam generator. Return valid JSON only. No markdown fences. No preamble.
CRITICAL: The JSON must be valid. All string values must properly escape special characters:
- Use \\" for quotes inside strings (especially in dialogues and citations)
- Use \\n for newlines inside strings
- Do NOT use actual line breaks inside JSON string values
- Ensure all quotes in dialogue passages are escaped as \\"`
    },
    { role: "user", content: prompt }
  ], maxTokens);

  const content = extractJSON(openaiRes);
  return jsonResponse(content);
}

/* ================= GRADE ================= */
async function handleGrade(request, env) {
  const body = await request.json();
  const { source_text_de, task_en, student_text_en, rubric_prompt } = body;

  // Input validation
  if (!source_text_de || typeof source_text_de !== "string") {
    return jsonResponse({ error: "source_text_de ist erforderlich." }, 400);
  }
  if (!task_en || typeof task_en !== "string") {
    return jsonResponse({ error: "task_en ist erforderlich." }, 400);
  }
  if (!student_text_en || typeof student_text_en !== "string") {
    return jsonResponse({ error: "student_text_en ist erforderlich." }, 400);
  }
  if (source_text_de.length > 20000 || task_en.length > 5000 || student_text_en.length > 20000) {
    return jsonResponse({ error: "Eingabetext ist zu lang." }, 400);
  }
  if (rubric_prompt && typeof rubric_prompt === "string" && rubric_prompt.length > 20000) {
    return jsonResponse({ error: "Bewertungsraster ist zu lang." }, 400);
  }

  const messages = [
    {
      role: "system",
      content: `You are a strict German Abitur English teacher grading a Sprachmittlung (mediation).
You must grade using the official ISB Bewertungsraster with Notenpunkte (0-15 NP).
Return your evaluation in the following JSON format ONLY (no markdown, no extra text):
{
  "inhalt_np": <number 0-15>,
  "sprache_np": <number 0-15>,
  "gesamt_np": <number 0-15>,
  "feedback": "<detailed feedback in German with Markdown formatting, citing specific student text passages>"
}
CALCULATION: gesamt_np = round(inhalt_np * 0.4 + sprache_np * 0.6)
SPERRKLAUSEL: If inhalt_np OR sprache_np is 0, gesamt_np must be at most 3.
IMPORTANT: Return ONLY valid JSON. No markdown fences. No preamble.`
    },
    {
      role: "user",
      content:
        `Deutscher Quelltext:\n${source_text_de}\n\n` +
        `Englische Aufgabenstellung:\n${task_en}\n\n` +
        `Schülertext (Englisch):\n${student_text_en}\n\n` +
        `Bewertungsraster:\n${rubric_prompt}`
    }
  ];

  const openaiRes = await callOpenAI(env, messages);

  // Try to parse structured JSON from response
  try {
    const parsed = extractJSON(openaiRes);

    const inhalt = parsed.inhalt_np ?? parsed.content_textstructure ?? null;
    const sprache = parsed.sprache_np ?? parsed.language ?? null;
    let gesamt = parsed.gesamt_np ?? null;

    // Calculate if not provided
    if (gesamt == null && inhalt != null && sprache != null) {
      gesamt = Math.round(inhalt * 0.4 + sprache * 0.6);
      // Apply Sperrklausel
      if (inhalt === 0 || sprache === 0) gesamt = Math.min(gesamt, 3);
    }

    return jsonResponse({
      scores: {
        content_textstructure: inhalt,
        language: sprache,
        total: gesamt
      },
      feedback: parsed.feedback || "",
      corrections: parsed.corrections || ""
    });
  } catch {
    // Fallback: try to extract scores with regex from unstructured text
    const contentMatch = openaiRes.match(/Inhalt[^:]*:\s*(\d{1,2})\s*(?:\/\s*15|\s*NP)/i)
      || openaiRes.match(/inhalt_np["\s:]*(\d{1,2})/i);
    const langMatch = openaiRes.match(/Sprache[^:]*:\s*(\d{1,2})\s*(?:\/\s*15|\s*NP)/i)
      || openaiRes.match(/sprache_np["\s:]*(\d{1,2})/i);
    const totalMatch = openaiRes.match(/Gesamt[^:]*:\s*(\d{1,2})\s*(?:\/\s*15|\s*NP)/i)
      || openaiRes.match(/gesamt_np["\s:]*(\d{1,2})/i);

    const contentScore = contentMatch ? Math.min(parseInt(contentMatch[1]), 15) : null;
    const langScore = langMatch ? Math.min(parseInt(langMatch[1]), 15) : null;
    let totalScore = totalMatch ? Math.min(parseInt(totalMatch[1]), 15) : null;

    if (totalScore == null && contentScore != null && langScore != null) {
      totalScore = Math.round(contentScore * 0.4 + langScore * 0.6);
      if (contentScore === 0 || langScore === 0) totalScore = Math.min(totalScore, 3);
    }

    return jsonResponse({
      scores: {
        content_textstructure: contentScore,
        language: langScore,
        total: totalScore
      },
      feedback: openaiRes,
      corrections: ""
    });
  }
}

/* ================= OCR ================= */
async function handleOCR(request, env) {
  const body = await request.json();
  const { image_base64 } = body;

  if (!image_base64 || typeof image_base64 !== "string") {
    return jsonResponse({ error: "No image provided" }, 400);
  }
  // Validate Base64 format and size (~10 MB limit)
  if (image_base64.length > 10 * 1024 * 1024) {
    return jsonResponse({ error: "Bild ist zu groß (max 10 MB)." }, 400);
  }

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe this handwritten text exactly as written. Preserve line breaks. Do not translate, do not correct errors. Output only the transcribed text."
            },
            {
              type: "image_url",
              image_url: { url: image_base64 }
            }
          ]
        }
      ],
      max_completion_tokens: 2000
    })
  });

  const data = await openaiRes.json();

  if (!openaiRes.ok) {
    throw new Error(data?.error?.message || "OpenAI Vision error");
  }

  const text = data?.choices?.[0]?.message?.content || "";
  return jsonResponse({ text });
}

/* ================= PARSE TASK (from uploaded images) ================= */
async function handleParseTask(request, env) {
  const body = await request.json();
  const { images } = body; // array of base64 image strings

  if (!images || !Array.isArray(images) || !images.length) {
    return jsonResponse({ error: "No images provided" }, 400);
  }
  if (images.length > 10) {
    return jsonResponse({ error: "Maximal 10 Bilder erlaubt." }, 400);
  }
  // Validate each image
  for (const img of images) {
    if (typeof img !== "string" || img.length > 10 * 1024 * 1024) {
      return jsonResponse({ error: "Ein Bild ist ungültig oder zu groß (max 10 MB)." }, 400);
    }
  }

  // Build content array with all images
  const content = [
    {
      type: "text",
      text: `You are looking at scanned pages of a German Abitur English mediation exam task.
Extract the following information and return it as JSON ONLY (no markdown fences, no extra text):

{
  "headline": "Title or topic of the German source text (if visible)",
  "article_text": "The complete German source text, transcribed exactly as written. Preserve paragraphs.",
  "task_instruction": "The complete English mediation task/instructions, transcribed exactly as written."
}

Rules:
- Transcribe the German text and English task EXACTLY as they appear. Do not translate or modify.
- If the text spans multiple pages/images, combine them in the correct order.
- Preserve paragraph breaks.
- If you cannot find a German source text or English task, set that field to an empty string.
- Return ONLY valid JSON.`
    }
  ];

  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: img }
    });
  }

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      messages: [{ role: "user", content }],
      max_completion_tokens: 4000,
      temperature: 0.2
    })
  });

  const data = await openaiRes.json();

  if (!openaiRes.ok) {
    throw new Error(data?.error?.message || "OpenAI Vision error");
  }

  const text = data?.choices?.[0]?.message?.content || "";
  const parsed = extractJSON(text);
  return jsonResponse(parsed);
}

/* ================= MODEL ANSWER ================= */
async function handleModelAnswer(request, env) {
  const { source_text_de, task_en } = await request.json();

  if (!source_text_de || typeof source_text_de !== "string") {
    return jsonResponse({ error: "source_text_de ist erforderlich." }, 400);
  }
  if (!task_en || typeof task_en !== "string") {
    return jsonResponse({ error: "task_en ist erforderlich." }, 400);
  }
  if (source_text_de.length > 20000 || task_en.length > 5000) {
    return jsonResponse({ error: "Eingabetext ist zu lang." }, 400);
  }

  const systemPrompt = `Du bist ein sehr guter Oberstufenschüler (Niveau B2/C1) an einem bayerischen Gymnasium. 
Schreibe eine Musterlösung für die folgende Mediation-Aufgabe.

WICHTIGE REGELN:
- Schreibe auf ENGLISCH.
- Halte dich genau an die Aufgabenstellung (Textsorte, Adressat, geforderte Inhalte).
- Verwende Mediation-Strategien: Paraphrasiere den deutschen Quelltext, übersetze NICHT wörtlich.
- Passe Stil und Register an die Kommunikationssituation an.
- Strukturiere den Text logisch mit Einleitung, Hauptteil und Schluss.
- Zielumfang: ca. 200–280 Wörter (typisch für Abitur-Mediation).
- Der Text soll sprachlich sehr gut sein (Niveau 5-6 BE), aber noch authentisch als Schülerarbeit wirken – also nicht übertrieben akademisch.

Formatiere deine Antwort als Markdown:
1. Zuerst die Musterlösung als Fließtext
2. Dann unter "---" eine kurze Erklärung (3-5 Sätze auf Deutsch), welche Strategien verwendet wurden und warum bestimmte Entscheidungen getroffen wurden.`;

  const userPrompt = `AUFGABENSTELLUNG:\n${task_en}\n\nDEUTSCHER QUELLTEXT:\n${source_text_de}`;

  const answer = await callOpenAI(env, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  return jsonResponse({ model_answer: answer });
}

/* ================= OPENAI CALL ================= */
async function callOpenAI(env, messages, maxTokens = 4000) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      messages,
      temperature: 0.7,
      max_completion_tokens: maxTokens
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI error");
  }
  return data.choices[0].message.content;
}

/* ================= DASHBOARD: SUBMIT RESULT ================= */
async function handleSubmitResult(request, env) {
  const { student_name, course, type, topic, content, language, total, date } = await request.json();

  if (!student_name || typeof student_name !== "string" || student_name.length > 200) {
    return jsonResponse({ error: "student_name ist erforderlich (max 200 Zeichen)." }, 400);
  }
  if (total == null || typeof total !== "number" || total < 0 || total > 15) {
    return jsonResponse({ error: "total muss eine Zahl zwischen 0 und 15 sein." }, 400);
  }
  if (course && (typeof course !== "string" || course.length > 50)) {
    return jsonResponse({ error: "Ungültiger Kurs." }, 400);
  }
  if (topic && (typeof topic !== "string" || topic.length > 500)) {
    return jsonResponse({ error: "topic ist zu lang." }, 400);
  }

  // Get existing results
  let results = [];
  try {
    const raw = await env.RESULTS_KV.get("all_results");
    if (raw) results = JSON.parse(raw);
  } catch {}

  // Add new result
  results.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    student_name,
    course: course || "",
    type: type || "mediation",
    topic: topic || "—",
    content: content ?? null,
    language: language ?? null,
    total,
    date: date || new Date().toISOString()
  });

  // Save back
  await env.RESULTS_KV.put("all_results", JSON.stringify(results));

  return jsonResponse({ success: true, count: results.length });
}

/* ================= DASHBOARD: GET RESULTS ================= */
async function handleGetResults(request, env) {
  const { teacher_password } = await request.json();

  // Separate teacher password check
  if (!env.TEACHER_PASSWORD) {
    return jsonResponse({ error: "Server-Konfigurationsfehler." }, 500);
  }
  if (teacher_password !== env.TEACHER_PASSWORD) {
    return jsonResponse({ error: "Falsches Lehrer-Passwort." }, 401);
  }

  let results = [];
  try {
    const raw = await env.RESULTS_KV.get("all_results");
    if (raw) results = JSON.parse(raw);
  } catch {}

  return jsonResponse({ results });
}

/* ================= DASHBOARD: DELETE RESULT ================= */
async function handleDeleteResult(request, env) {
  const { teacher_password, result_id } = await request.json();

  if (!result_id || typeof result_id !== "string" || result_id.length > 100) {
    return jsonResponse({ error: "Ungültige result_id." }, 400);
  }
  if (!env.TEACHER_PASSWORD) {
    return jsonResponse({ error: "Server-Konfigurationsfehler." }, 500);
  }
  const teacherPw = env.TEACHER_PASSWORD;
  if (teacher_password !== teacherPw) {
    return jsonResponse({ error: "Falsches Lehrer-Passwort." }, 401);
  }

  let results = [];
  try {
    const raw = await env.RESULTS_KV.get("all_results");
    if (raw) results = JSON.parse(raw);
  } catch {}

  results = results.filter(r => r.id !== result_id);
  await env.RESULTS_KV.put("all_results", JSON.stringify(results));

  return jsonResponse({ success: true, count: results.length });
}

/* ================= HELPERS ================= */
function extractJSON(text) {
  // Step 1: Clean markdown fences
  let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  // Step 2: Try direct parse
  try { return JSON.parse(clean); } catch {}

  // Step 3: Extract JSON object from surrounding text
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}

    // Step 4: Try to repair common issues
    let repaired = match[0];

    // Fix unescaped newlines inside strings
    repaired = repaired.replace(/:\s*"([\s\S]*?)"\s*([,\}])/g, (m, val, end) => {
      const fixed = val
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return ': "' + fixed + '"' + end;
    });
    try { return JSON.parse(repaired); } catch {}

    // Step 5: More aggressive repair – fix unescaped quotes in values
    // Replace the content between key-value pairs
    repaired = match[0];
    repaired = repaired.replace(/([{,]\s*"[^"]+"\s*:\s*")([^]*?)("\s*[,\}])/g, (m, pre, val, post) => {
      // Escape any unescaped quotes inside the value
      const fixed = val
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "")
        .replace(/\t/g, "\\t");
      return pre + fixed + post;
    });
    try { return JSON.parse(repaired); } catch {}

    // Step 6: Last resort – try to build object from key extraction
    try {
      const keys = ["headline", "source_info", "article_text", "task_instruction",
                     "task_1", "task_2", "task_3_1_quote", "task_3_1",
                     "task_3_2_situation", "task_3_2",
                     "inhalt_np", "sprache_np", "gesamt_np", "feedback", "corrections"];
      const obj = {};
      for (const key of keys) {
        const re = new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"\\s*[,\\}]');
        const km = clean.match(re);
        if (km) obj[key] = km[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
      // Also try numeric values
      for (const key of ["inhalt_np", "sprache_np", "gesamt_np", "content_textstructure", "language", "total"]) {
        const re = new RegExp('"' + key + '"\\s*:\\s*(\\d+)');
        const km = clean.match(re);
        if (km) obj[key] = parseInt(km[1]);
      }
      if (Object.keys(obj).length >= 2) return obj;
    } catch {}
  }

  throw new Error("Model did not return valid JSON.");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(currentOrigin)
  });
}

const ALLOWED_ORIGINS = [
  "https://sanktannagymnasium.workers.dev",
  "https://sag-abi-mediation.sanktannagymnasium.workers.dev",
  "https://www.st-anna-gymnasium.de",
  "https://st-anna-gymnasium.de"
];

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Password",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}
