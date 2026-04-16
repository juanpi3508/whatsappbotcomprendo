import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const state = {
  question: null,
  correctAnswer: null,
  responses: []
};

function cleanJson(text) {
  if (!text) {
    throw new Error("Gemini no devolvio texto.");
  }

  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

async function generateQuestion(topic) {
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `Devuelve SOLO JSON valido con exactamente esta estructura:
{
  "question": "pregunta corta sobre ${topic}",
  "options": {
    "A": "opcion",
    "B": "opcion",
    "C": "opcion",
    "D": "opcion"
  },
  "correct": "A"
}

Reglas:
- Una sola pregunta
- 4 opciones
- Una sola respuesta correcta
- Nivel bachillerato
- No expliques nada fuera del JSON`
  });

  const rawText = response.text;
  const cleaned = cleanJson(rawText);
  const parsed = JSON.parse(cleaned);

  if (
    !parsed.question ||
    !parsed.options ||
    !parsed.options.A ||
    !parsed.options.B ||
    !parsed.options.C ||
    !parsed.options.D ||
    !["A", "B", "C", "D"].includes(parsed.correct)
  ) {
    throw new Error("Gemini devolvio un formato invalido.");
  }

  return parsed;
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
    const topic = req.body.topic || "ecuaciones lineales";
    const studentNumber = req.body.studentNumber || process.env.STUDENT_NUMBER;

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