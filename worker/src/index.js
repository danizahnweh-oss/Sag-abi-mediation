export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);

      const body = await request.json();

      if (path === "/api/generate") return handleGenerate(body, env);
      if (path === "/api/grade") return handleGrade(body, env);
      if (path === "/api/ocr") return handleOCR(body, env);

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function openaiResponses({ env, model, instructions, input, schema }) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      instructions,
      input,
      ...(schema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: schema.name,
                strict: true,
                schema: schema.schema
              }
            }
          }
        : {})
    })
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status} ${JSON.stringify(data)}`);
  const out = (data.output_text || "").trim();
  return { raw: out, data };
}

const RUBRIC = {
  content_textstructure: {
    4: [
      "operator fully met; complete, correct, redundancy-free",
      "clear structure; all necessary info; relevant cultural explanations where needed",
      "recipient/text type fully appropriate",
      "effective paraphrasing/mediation strategies"
    ],
    3: [
      "operator largely met",
      "mostly structured; essential info included; mostly relevant cultural explanations",
      "recipient/text type mostly appropriate",
      "generally effective paraphrasing"
    ],
    2: [
      "operator partly met; overall still met",
      "only partly structured; some inaccuracies/omissions; cultural explanations only basic",
      "recipient/text type partly appropriate",
      "paraphrasing only sometimes"
    ],
    1: ["operator barely met; incomplete/unstructured; weak recipient focus"],
    0: ["not met; off-topic / no task relevance"]
  },
  language: {
    6: ["near error-free; wide repertoire; very appropriate/varied expression"],
    5: ["mostly error-free; solid repertoire; mostly appropriate/varied"],
    4: ["several mostly minor errors; meaning largely clear; adequate range"],
    3: ["several errors incl. occasional serious ones; overall understandable; limited range"],
    2: ["many serious errors; clarity often affected; clearly limited range"],
    1: ["very many serious errors; overall clarity impaired; very limited range"],
    0: ["not understandable"]
  }
};

async function handleGenerate(body, env) {
  const { topic, source_len_words, genre_hint, audience_hint, aspects_hint } = body || {};
  if (!topic) return json({ error: "Missing topic" }, 400);

  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const instructions =
    "You are an English exam preparation assistant for Bavarian Gymnasium (upper secondary). " +
    "Generate a German source text and an English mediation task. " +
    "Keep it realistic and age-appropriate.";

  const input = [
    {
      role: "user",
      content:
        `Topic: ${topic}\n` +
        `German source length target: ~${Number(source_len_words || 220)} words\n` +
        `Hints:\n- genre_hint: ${genre_hint || "none"}\n- audience_hint: ${audience_hint || "none"}\n- aspects_hint: ${aspects_hint || "none"}\n\n` +
        "Return JSON with:\n" +
        '{ "source_text_de": "...", "task_en": "..." }\n' +
        "Task must include a clear situation (recipient + text type) and 2–3 explicit aspects."
    }
  ];

  const schema = {
    name: "mediation_task",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["source_text_de", "task_en"],
      properties: {
        source_text_de: { type: "string", minLength: 150 },
        task_en: { type: "string", minLength: 80 }
      }
    }
  };

  const { raw } = await openaiResponses({ env, model, instructions, input, schema });
  return json(JSON.parse(raw));
}

async function handleGrade(body, env) {
  const { source_text_de, task_en, student_text_en } = body || {};
  if (!source_text_de || !task_en || !student_text_en) {
    return json({ error: "Missing fields" }, 400);
  }

  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const instructions =
    "You are a strict but helpful examiner for Bavarian Gymnasium English mediation (Sprachmittlung), level B1+/B2. " +
    "Grade using the rubric descriptors provided. Do not invent information not in the source.";

  const input = [
    {
      role: "user",
      content:
        `TASK (EN):\n${task_en}\n\n` +
        `GERMAN SOURCE (DE):\n${source_text_de}\n\n` +
        `STUDENT ANSWER (EN):\n${student_text_en}\n\n` +
        `RUBRIC:\nContent/Text structure 0-4: ${JSON.stringify(RUBRIC.content_textstructure)}\n` +
        `Language 0-6: ${JSON.stringify(RUBRIC.language)}\n\n` +
        "Return ONLY JSON with:\n" +
        '{ scores:{content_textstructure:0..4, language:0..6, total:0..10}, feedback:"...", corrections:"..." }'
    }
  ];

  const schema = {
    name: "mediation_grading",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores", "feedback", "corrections"],
      properties: {
        scores: {
          type: "object",
          additionalProperties: false,
          required: ["content_textstructure", "language", "total"],
          properties: {
            content_textstructure: { type: "integer", minimum: 0, maximum: 4 },
            language: { type: "integer", minimum: 0, maximum: 6 },
            total: { type: "integer", minimum: 0, maximum: 10 }
          }
        },
        feedback: { type: "string", minLength: 60 },
        corrections: { type: "string" }
      }
    }
  };

  const { raw } = await openaiResponses({ env, model, instructions, input, schema });
  const out = JSON.parse(raw);
  out.scores.total = (out.scores.content_textstructure || 0) + (out.scores.language || 0);
  return json(out);
}

async function handleOCR(body, env) {
  const { image_data_url } = body || {};
  if (!image_data_url) return json({ error: "Missing image_data_url" }, 400);

  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const instructions =
    "You are an OCR system. Extract the handwritten or printed text from the image. " +
    "Return plain text only. Preserve line breaks where helpful.";

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      instructions,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "OCR this image into text." },
            { type: "input_image", image_url: image_data_url, detail: "high" }
          ]
        }
      ]
    })
  });

  const data = await resp.json();
  if (!resp.ok) return json({ error: `OpenAI error: ${resp.status}`, details: data }, 500);

  return json({ text: (data.output_text || "").trim() });
}
