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
      .insert([{ userId, symptoms: symptoms, questions: questions }]);

    if (error) {
      console.error("Error inserting session:", error.message);
      res.status(500).send({ error: "Error inserting session" });
    } else {
      res.status(200).send({
        message: "New diagnosis session started",
        diagnosisQuestions: questions,
      });
    }
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
