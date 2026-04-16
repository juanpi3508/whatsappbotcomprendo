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

// Estado simple en memoria para PMV
const state = {
  classTopic: "ecuaciones lineales",
  quiz: [],
  studentSessions: {},
  responses: []
};

// -----------------------------
// Helpers
// -----------------------------

function normalizeGeminiJson(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Gemini no devolvio texto valido.");
  }

  // Quita fences ```json ... ```
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  return cleaned;
}

async function generateQuiz(topic) {
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `Devuelve solo JSON valido con 3 preguntas de opcion multiple sobre ${topic}. Formato exacto:
{"questions":[
{"question":"texto","options":{"A":"texto","B":"texto","C":"texto","D":"texto"},"correct":"A"},
{"question":"texto","options":{"A":"texto","B":"texto","C":"texto","D":"texto"},"correct":"B"},
{"question":"texto","options":{"A":"texto","B":"texto","C":"texto","D":"texto"},"correct":"C"}
]}`
  });

  const rawText = response.text;
  const cleaned = normalizeGeminiJson(rawText);
  return JSON.parse(cleaned);
}

async function sendWhatsAppMessage(to, body) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body
  });
}

async function sendQuestion(to, questionIndex) {
  const q = state.quiz[questionIndex];

  const body = `Pregunta ${questionIndex + 1}/3

${q.question}

A) ${q.options.A}
B) ${q.options.B}
C) ${q.options.C}
D) ${q.options.D}

Responde solo con A, B, C o D.`;

  await sendWhatsAppMessage(to, body);
}

function gradeAnswers(quiz, answers) {
  let correctCount = 0;
  const results = [];

  for (let i = 0; i < quiz.length; i++) {
    const studentAnswer = answers[i] || null;
    const correctAnswer = quiz[i].correct;
    const isCorrect = studentAnswer === correctAnswer;

    if (isCorrect) {
      correctCount++;
    }

    results.push({
      question: i + 1,
      studentAnswer,
      correctAnswer,
      isCorrect
    });
  }

  let level = "bajo";
  if (correctCount === 2) level = "medio";
  if (correctCount === 3) level = "alto";

  return {
    correctCount,
    total: quiz.length,
    level,
    results
  };
}

// -----------------------------
// Rutas
// -----------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "bot-whatsapp-comprendo"
  });
});

app.get("/report", (req, res) => {
  res.json({
    topic: state.classTopic,
    quiz: state.quiz,
    totalResponses: state.responses.length,
    responses: state.responses,
    sessions: state.studentSessions
  });
});

app.post("/start-class", async (req, res) => {
  try {
    const topic = req.body.topic || "ecuaciones lineales";
    const studentNumber = req.body.studentNumber || process.env.STUDENT_NUMBER;

    const data = await generateQuiz(topic);

    state.classTopic = topic;
    state.quiz = data.questions;
    state.responses = [];

    state.studentSessions[studentNumber] = {
      currentQuestion: 0,
      answers: [],
      completed: false,
      startedAt: new Date().toISOString()
    };

    await sendWhatsAppMessage(
      studentNumber,
      `Hola. Vamos a hacer un cierre de clase sobre: ${topic}.

Te enviare 3 preguntas, una por una.
Responde cada una solo con A, B, C o D.`
    );

    await sendQuestion(studentNumber, 0);

    res.json({
      ok: true,
      topic,
      quizGenerated: true,
      firstQuestionSent: true
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
    const body = (req.body.Body || "").trim().toUpperCase();

    const session = state.studentSessions[from];

    if (!session) {
      twiml.message("No tienes un cuestionario activo en este momento.");
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.completed) {
      twiml.message("Ya completaste este cuestionario.");
      return res.type("text/xml").send(twiml.toString());
    }

    if (!["A", "B", "C", "D"].includes(body)) {
      twiml.message("Respuesta no valida. Responde solo con A, B, C o D.");
      return res.type("text/xml").send(twiml.toString());
    }

    // Guardar respuesta
    session.answers[session.currentQuestion] = body;
    session.currentQuestion += 1;

    // Si aun faltan preguntas, enviar la siguiente
    if (session.currentQuestion < state.quiz.length) {
      await sendQuestion(from, session.currentQuestion);
      return res.type("text/xml").send(twiml.toString());
    }

    // Si ya termino, corregir
    session.completed = true;
    session.completedAt = new Date().toISOString();

    const grading = gradeAnswers(state.quiz, session.answers);

    const resultRecord = {
      from,
      topic: state.classTopic,
      answers: session.answers,
      grading,
      at: new Date().toISOString()
    };

    state.responses.push(resultRecord);

    twiml.message(
      `Gracias. Completaste el cuestionario.

Puntaje: ${grading.correctCount}/${grading.total}
Nivel: ${grading.level}`
    );

    // Reporte al docente
    if (process.env.TEACHER_NUMBER) {
      const detailLines = grading.results
        .map((r) => {
          return `Pregunta ${r.question}: respondio ${r.studentAnswer}, correcta ${r.correctAnswer}, ${r.isCorrect ? "correcta" : "incorrecta"}`;
        })
        .join("\n");

      await sendWhatsAppMessage(
        process.env.TEACHER_NUMBER,
        `Nuevo reporte de estudiante

Tema: ${state.classTopic}
Puntaje: ${grading.correctCount}/${grading.total}
Nivel: ${grading.level}

Detalle:
${detailLines}`
      );
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