import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const PORT = process.env.PORT || 3000;

const state = {
  classTopic: "ecuaciones lineales",
  questions: [],
  responses: []
};

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "bot-whatsapp-comprendo" });
});

async function generateQuestions(topic) {
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `
Genera exactamente 3 preguntas de comprensión cortas para estudiantes de bachillerato.
Tema: ${topic}

Devuelve SOLO JSON válido con esta forma:
{
  "questions": [
    "pregunta 1",
    "pregunta 2",
    "pregunta 3"
  ]
}
`
  });

  return JSON.parse(response.text);
}

async function analyzeStudentAnswer(topic, questions, answerText) {
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `
Tema de la clase: ${topic}

Preguntas enviadas:
1. ${questions[0]}
2. ${questions[1]}
3. ${questions[2]}

Respuesta del estudiante:
${answerText}

Devuelve SOLO JSON válido con esta forma:
{
  "nivel_comprension": "alto|medio|bajo",
  "conceptos_no_comprendidos": ["concepto 1", "concepto 2"],
  "resumen_docente": "texto corto"
}
`
  });

  return JSON.parse(response.text);
}

app.post("/start-class", async (req, res) => {
  try {
    const topic = req.body.topic || "ecuaciones lineales";
    const studentNumber = req.body.studentNumber || process.env.STUDENT_NUMBER;

    const data = await generateQuestions(topic);
    state.classTopic = topic;
    state.questions = data.questions;
    state.responses = [];

    const body = `Hola. Cierre de clase: ${topic}

Responde estas 3 preguntas en un solo mensaje:

1. ${data.questions[0]}
2. ${data.questions[1]}
3. ${data.questions[2]}

Puedes responder numerando 1, 2 y 3.`;

    const msg = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: studentNumber,
      body
    });

    res.json({
      ok: true,
      topic,
      questions: data.questions,
      twilioMessageSid: msg.sid
    });
  } catch (error) {
    console.error(error);
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
    const body = req.body.Body || "";

    const analysis = await analyzeStudentAnswer(
      state.classTopic,
      state.questions,
      body
    );

    state.responses.push({
      from,
      body,
      analysis,
      at: new Date().toISOString()
    });

    twiml.message(
      `Gracias. Registré tu respuesta.

Nivel detectado: ${analysis.nivel_comprension}
Conceptos con duda: ${(analysis.conceptos_no_comprendidos || []).join(", ") || "ninguno"}`
    );

    if (process.env.TEACHER_NUMBER) {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: process.env.TEACHER_NUMBER,
        body: `Nuevo reporte de estudiante

Tema: ${state.classTopic}
Nivel: ${analysis.nivel_comprension}
Dudas: ${(analysis.conceptos_no_comprendidos || []).join(", ") || "ninguna"}
Resumen: ${analysis.resumen_docente}`
      });
    }

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error(error);
    twiml.message("Hubo un error procesando tu respuesta.");
    res.type("text/xml").send(twiml.toString());
  }
});

app.get("/report", (req, res) => {
  res.json({
    topic: state.classTopic,
    questions: state.questions,
    totalResponses: state.responses.length,
    responses: state.responses
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});