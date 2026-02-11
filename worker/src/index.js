export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
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
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: corsHeaders() }
      );
    }
  }
};

/* ================= GENERATE ================= */
async function handleGenerate(request, env) {
  const body = await request.json();
  const { topic, source_len_words, prompt_template } = body;

  // Replace placeholders that the frontend couldn't resolve
  const prompt = prompt_template
    .replace(/\{topic\}/g, topic || "")
    .replace(/\$\{topic\}/g, topic || "")
    .replace(/\{length\}/g, String(source_len_words || 600))
    .replace(/\$\{length\}/g, String(source_len_words || 600));

  const openaiRes = await callOpenAI(env, [
    {
      role: "system",
      content: "You are an Abitur exam generator. Return valid JSON only. No markdown fences."
    },
    { role: "user", content: prompt }
  ]);

  const content = extractJSON(openaiRes);
  return jsonResponse(content);
}

/* ================= GRADE ================= */
async function handleGrade(request, env) {
  const body = await request.json();
  const { source_text_de, task_en, student_text_en, rubric_prompt } = body;

  const messages = [
    {
      role: "system",
      content: `You are a strict German Abitur English teacher. 
You must grade the student's mediation and return your evaluation in the following JSON format ONLY (no markdown, no extra text):
{
  "content_textstructure": <number 0-4>,
  "language": <number 0-6>,
  "total": <number 0-10>,
  "feedback": "<detailed feedback in German with Markdown formatting>",
  "corrections": "<specific corrections and error list in German with Markdown formatting>"
}
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
    return jsonResponse({
      scores: {
        content_textstructure: parsed.content_textstructure ?? null,
        language: parsed.language ?? null,
        total: parsed.total ?? (
          (parsed.content_textstructure != null && parsed.language != null)
            ? parsed.content_textstructure + parsed.language
            : null
        )
      },
      feedback: parsed.feedback || "",
      corrections: parsed.corrections || ""
    });
  } catch {
    // Fallback: try to extract scores with regex from unstructured text
    const contentMatch = openaiRes.match(/Inhalt[^:]*:\s*(\d)\s*\/\s*4/i)
      || openaiRes.match(/content[^:]*:\s*(\d)/i);
    const langMatch = openaiRes.match(/Sprache[^:]*:\s*(\d)\s*\/\s*6/i)
      || openaiRes.match(/language[^:]*:\s*(\d)/i);
    const totalMatch = openaiRes.match(/Gesamt[^:]*:\s*(\d+)\s*\/\s*10/i)
      || openaiRes.match(/total[^:]*:\s*(\d+)/i);

    const contentScore = contentMatch ? parseInt(contentMatch[1]) : null;
    const langScore = langMatch ? parseInt(langMatch[1]) : null;
    const totalScore = totalMatch
      ? parseInt(totalMatch[1])
      : (contentScore != null && langScore != null ? contentScore + langScore : null);

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

  if (!image_base64) {
    return jsonResponse({ error: "No image provided" }, 400);
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
      max_tokens: 2000
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

  if (!images || !images.length) {
    return jsonResponse({ error: "No images provided" }, 400);
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
      max_tokens: 4000,
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

/* ================= OPENAI CALL ================= */
async function callOpenAI(env, messages) {
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
      max_tokens: 4000
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI error");
  }
  return data.choices[0].message.content;
}

/* ================= HELPERS ================= */
function extractJSON(text) {
  try {
    // Remove markdown code fences if present
    const clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    return JSON.parse(clean);
  } catch {
    // Try to find JSON object in the text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        throw new Error("Model did not return valid JSON.");
      }
    }
    throw new Error("Model did not return valid JSON.");
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}
