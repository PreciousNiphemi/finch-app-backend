import express from "express";
import { createClient } from "@supabase/supabase-js";
import morgan from "morgan";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI, { OpenAIError } from "openai";

dotenv.config();
const app = express();

// using morgan for logs
app.use(morgan("combined"));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

app.post("/sign-in", async (req, res) => {
  console.log("THE BODY", req.body);
  const { phone } = req.body; // Extract phone number from request body
  console.log("number", phone);
  const { data, error } = await supabase.auth.signInWithOtp({
    phone: phone,
  });
  if (error) {
    console.error("Error signing up:", error);
    res.status(500).send({ error: "Error signing up" });
  } else {
    console.log("User data:", data);
    res.status(200).send({
      message:
        "The verification token has been sent to your number. Please confirm.",
    });
  }
});

app.post("/verify-otp", async (req, res) => {
  const { phone, token } = req.body;

  const {
    data: { user, session },
    error,
  } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: "sms",
  });

  if (error) {
    console.error("Error verifying OTP:", error.message);
    res.status(500).send({ error: "Error verifying OTP" });
  } else {
    // Insert the new user into the 'users' table
    const { data, error: insertError } = await supabase
      .from("users")
      .insert([{ id: user.id, phone: phone }]);

    console.log("THE DATA  FROM SETTING USERS", data);
    if (insertError) {
      console.error("Error inserting user:", insertError.message);
      res.status(500).send({ error: "Error inserting user" });
    } else {
      console.log("OTP verified:", session);
      res.status(200).send({ message: "Authentication successful", session });
    }
  }
});

app.post("/initiate-session", async (req, res) => {
  const { symptoms, userId } = req.body;

  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "you are a expert diagnostic AI assistant, you help new parents understand illnesses with their babies and diagnose issues",
      },
      {
        role: "user",
        content: `The patient is currently experiencing these symptoms in their words;
           "${symptoms}".
           Can you generate 10 questions to help diagnose these symptoms?
           `,
      },
    ],
    model: "gpt-3.5-turbo",
    functions: [
      {
        name: "get_diagnosis_questions",
        description: "Get 10 yes/no diagnosis questions to provide a diagnosis",
        parameters: {
          type: "object",
          properties: {
            diagnosis_questions: {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "An array of 10 diagnosis questions to ask a patient",
            },
          },
          required: [],
        },
      },
    ],
    function_call: "auto",
  });

  let responseMessage = completion.choices[0].message;
  if (responseMessage.function_call.name === "get_diagnosis_questions") {
    //response JSON from gpt
    const args = JSON.parse(responseMessage.function_call.arguments);

    let questions = args.diagnosis_questions;

    // Insert the new session into the 'sessions' table
    const { data, error } = await supabase
      .from("sessions")
      .insert([{ userId, symptoms: symptoms, questions: [questions[0]] }])
      .select();
    if (error) {
      console.error("Error inserting session:", error.message);
      res.status(500).send({ error: "Error inserting session" });
    } else {
      res.status(200).send({
        message: "New diagnosis session started",
        sessionId: data[0].id,
        diagnosisQuestion: questions[0],
      });
    }
  }
});

app.post("/patient-response", async (req, res) => {
  const DEFAULT_QUESTION_NO = 10;
  const { answer, question, sessionId } = req.body;

  const userResponse = {
    question: question,
    answer: answer,
  };

  try {
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", sessionId);

    if (error) {
      console.error("Error fetching session:", error.message);
      return res.status(500).send({ error: "Error fetching session" });
    }

    const updateSupabase = await supabase
      .from("sessions")
      .update({
        answers: data[0].answers
          ? [...data[0].answers, userResponse]
          : [userResponse],
      })
      .eq("id", sessionId)
      .select();

    console.log("SUPABASE UPDATE WITH RESPONSE ==== >", updateSupabase);

    if (updateSupabase.error) {
      console.error("Error updating session:", updateSupabase.error.message);
      return res.status(500).send({ error: "Error updating session" });
    }

    if (
      updateSupabase.data[0]?.questions &&
      updateSupabase.data[0]?.questions?.length < DEFAULT_QUESTION_NO
    ) {
      const numberOfQuestionsToAsk =
        DEFAULT_QUESTION_NO - updateSupabase.data[0]?.questions.length;
      const completion = await openai.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "you are a expert diagnostic AI assistant, you help new parents understand illnesses with their babies and diagnose issues",
          },
          {
            role: "user",
            content: `The patient is currently experiencing these symptoms in their words;
              "${
                updateSupabase.data[0].symptoms
              }". The patient was asked the following questions. Here are the questions and their answers: "${updateSupabase.data[0].answers
              .map((a) => a.question + ": " + a.answer)
              .join(
                ", "
              )}". Can you generate ${numberOfQuestionsToAsk} additional yes or no questions to help diagnose these symptoms?
                 `,
          },
        ],
        model: "gpt-3.5-turbo",
        functions: [
          {
            name: "get_diagnosis_questions",
            description: `Get ${numberOfQuestionsToAsk} yes/no diagnosis questions to provide a diagnosis`,
            parameters: {
              type: "object",
              properties: {
                diagnosis_questions: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description: `An array of ${numberOfQuestionsToAsk} diagnosis questions to ask a patient`,
                },
              },
              required: [],
            },
          },
        ],
        function_call: "auto",
      });

      let responseMessage = completion.choices[0].message;
      if (responseMessage.function_call.name === "get_diagnosis_questions") {
        const args = JSON.parse(responseMessage.function_call.arguments);

        let newQuestions = args.diagnosis_questions;

        console.log("NEW QUESTIONS", newQuestions);

        const updateWithNewQuestion = await supabase
          .from("sessions")
          .update({
            questions: data[0].questions
              ? [...data[0].questions, newQuestions[0]]
              : [userResponse],
          })
          .eq("id", sessionId)
          .select();

        console.log("NEW UPDATE QUESTIONS ==== >", updateWithNewQuestion);

        if (updateWithNewQuestion.error) {
          console.error(
            "Error inserting session:",
            updateWithNewQuestion.error.message
          );
          return res.status(500).send({ error: "Error inserting session" });
        } else {
          return res.status(200).send({
            message: "New diagnosis question",
            sessionId: updateWithNewQuestion.data[0].id,
            diagnosisQuestion: newQuestions[0],
          });
        }
      }
    } else {
      return res.status(200).send({
        message: "Diagnosis session completed",
        sessionId: updateSupabase.data[0].id,
      });
    }
  } catch (err) {
    console.error("Unexpected error:", err.message);
    return res.status(500).send({ error: "Unexpected error" });
  }
});

app.get("/", (req, res) => {
  res.send("Hello I am working with Supabase <3");
});

app.get("*", (req, res) => {
  res.send("Hello again I am working my friend to the moon and behind <3");
});

app.listen(3000, () => {
  console.log(`> Ready on http://localhost:3000`);
});
