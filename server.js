import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const state = {
  question: null,
  correctAnswer: null,
  responses: []
};

async function generateQuestion(topic) {
  const fallback = {
    question: "¿Cuál es el valor de x en 2x + 3 = 11?",
    options: {
      A: "3",
      B: "4",
      C: "5",
      D: "6"
    },
    correct: "B"
  };

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "llama-3.1-8b-instant",
    messages: [
          {
            role: "system",
            content: "Devuelve solo JSON valido. No uses markdown."
          },
          {
            role: "user",
            content: `Genera 1 pregunta coherente de opcion multiple con una sola opción valida sobre ${topic}.
Devuelve SOLO este formato JSON:
{"question":"texto","options":{"A":"texto","B":"texto","C":"texto","D":"texto"},"correct":"A"}`
          }
        ],
        temperature: 0.2,
        max_tokens: 180
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenRouter error:", JSON.stringify(data));
      return fallback;
    }

    let text = data?.choices?.[0]?.message?.content;

    if (!text || typeof text !== "string") {
      console.error("OpenRouter content vacio:", JSON.stringify(data));
      return fallback;
    }

    text = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      console.error("No se encontro JSON valido en:", text);
      return fallback;
    }

    const jsonText = text.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonText);

    if (
      !parsed.question ||
      !parsed.options ||
      !parsed.options.A ||
      !parsed.options.B ||
      !parsed.options.C ||
      !parsed.options.D ||
      !["A", "B", "C", "D"].includes(parsed.correct)
    ) {
      console.error("Formato invalido devuelto por OpenRouter:", parsed);
      return fallback;
    }

    return parsed;
  } catch (error) {
    console.error("Fallo generateQuestion, usando fallback:", error.message);
    return fallback;
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "bot-whatsapp-comprendo"
  });
});

app.get("/report", (req, res) => {
  res.json({
    question: state.question,
    correctAnswer: state.correctAnswer,
    totalResponses: state.responses.length,
    responses: state.responses
  });
});

app.post("/start-class", async (req, res) => {
  try {
    const topic = String(req.body.topic || "").trim();
    const studentNumber = req.body.studentNumber || process.env.STUDENT_NUMBER;

    // Validacion obligatoria: sin topic no se genera ni se envia nada
    if (!topic) {
      return res.status(400).json({
        ok: false,
        error: "El campo 'topic' es obligatorio. No se envio ninguna pregunta."
      });
    }

    if (!studentNumber) {
      return res.status(400).json({
        ok: false,
        error: "No se encontro el numero del estudiante."
      });
    }

    const q = await generateQuestion(topic);

    state.question = q;
    state.correctAnswer = q.correct;
    state.responses = [];

    const body = `Cierre de clase: ${topic}

${q.question}

A) ${q.options.A}
B) ${q.options.B}
C) ${q.options.C}
D) ${q.options.D}

Responde solo con A, B, C o D.`;

    const msg = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: studentNumber,
      body
    });

    res.json({
      ok: true,
      topic,
      question: q.question,
      twilioMessageSid: msg.sid
    });
  } catch (error) {
    console.error("ERROR /start-class:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From;
    const answer = (req.body.Body || "").trim().toUpperCase();

    if (!state.question || !state.correctAnswer) {
      twiml.message("No hay una pregunta activa en este momento.");
      return res.type("text/xml").send(twiml.toString());
    }

    if (!["A", "B", "C", "D"].includes(answer)) {
      twiml.message("Respuesta no valida. Responde solo con A, B, C o D.");
      return res.type("text/xml").send(twiml.toString());
    }

    const correct = state.correctAnswer;
    const isCorrect = answer === correct;

    state.responses.push({
      from,
      answer,
      correct,
      isCorrect,
      at: new Date().toISOString()
    });

    twiml.message(
      isCorrect
        ? "Correcto ✅"
        : `Incorrecto ❌. La respuesta correcta era ${correct}`
    );

    if (process.env.TEACHER_NUMBER) {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: process.env.TEACHER_NUMBER,
        body: `Nuevo reporte

Estudiante: ${from}
Pregunta: ${state.question.question}
Respuesta estudiante: ${answer}
Respuesta correcta: ${correct}
Resultado: ${isCorrect ? "Correcto" : "Incorrecto"}`
      });
    }

    return res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("ERROR /whatsapp:", error);
    twiml.message("Hubo un error procesando tu respuesta.");
    return res.type("text/xml").send(twiml.toString());
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
