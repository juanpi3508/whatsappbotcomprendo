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

function generateQuestion(topic) {
  const t = String(topic || "").toLowerCase();

  if (t.includes("ecuaciones")) {
    return {
      question: "¿Cuál es el valor de x en 2x + 3 = 11?",
      options: {
        A: "3",
        B: "4",
        C: "5",
        D: "6"
      },
      correct: "B"
    };
  }

  if (t.includes("fotosintesis")) {
    return {
      question: "¿Qué necesitan las plantas para realizar la fotosíntesis?",
      options: {
        A: "Luz solar, agua y dióxido de carbono",
        B: "Solo oxígeno",
        C: "Solo agua",
        D: "Solo tierra"
      },
      correct: "A"
    };
  }

  return {
    question: `¿Cuál fue la idea principal de la clase sobre ${topic}?`,
    options: {
      A: "Un concepto secundario",
      B: "La idea central explicada en clase",
      C: "Un tema no relacionado",
      D: "Una fecha del calendario"
    },
    correct: "B"
  };
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

    const q = generateQuestion(topic);

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
      twiml.message("Respuesta no válida. Responde solo con A, B, C o D.");
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