import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import fs from "fs";
import OpenAI from "openai";
import multer from "multer";
import mammoth from "mammoth";
import { Pinecone } from "@pinecone-database/pinecone";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { PDFParse } from 'pdf-parse';
import {
  McpServer,
  ResourceTemplate
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import axios from "axios";

console.log("typeof pdfParse:", typeof PDFParse); // should log "function"


const JOBS_NS = "jobs";




dotenv.config();

const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" }); // saves to ./uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});


const index = pc.index(process.env.PINECONE_INDEX);


admin.initializeApp({
    credential: admin.credential.cert("./firebase-service-account.json"),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Verify Firebase ID token
async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}


function chunkText(text, size = 1000, overlap = 100) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    const chunk = text.slice(start, end);
    chunks.push(chunk);
    start += size - overlap;
  }

  return chunks;
}

//Create User
app.post("/api/init-user", verifyToken, async (req, res) => {
  try {
    const { name, email, photoURL } = req.body;
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);

    // Create or update main user doc
    await userRef.set(
      {
        name,
        email,
        photoURL,
        updatedAt: new Date(),
      },
      { merge: true }
    );

   

    res.json({ success: true });
  } catch (err) {
    console.error("Error initializing user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 🧩 Get current user context
app.get("/api/user", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const docSnap = await db.collection("users").doc(uid).get();
  res.json(docSnap.exists ? docSnap.data() : {});
});

// POST /api/ask { uid, question }
app.post("/api/ask", async (req, res) => {
  const { uid, question, conversation } = req.body;
  if (!uid || !question)
    return res.status(400).json({ error: "Missing uid or question" });

  try {
    // 1️⃣ Fetch user’s main profile (still useful context)
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists)
      return res.status(404).json({ error: "User not found" });

    const userData = userSnap.data();

    // 2️⃣ Create embedding for the question
    const queryEmbedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    });
    const queryVector = queryEmbedding.data[0].embedding;

    // 3️⃣ Query Pinecone for most relevant user data
    const userIndex = index.namespace(uid + "Public"); // 👈 isolates to that user
    const pineconeResults = await userIndex.query({
      vector: queryVector,
      topK: 5,
      includeMetadata: true,
    });

    // 4️⃣ Merge the retrieved text snippets
    const retrievedContext = pineconeResults.matches
      .map((match) => match.metadata.text)
      .join("\n\n");

    

    const fullProfile = { ...userData };

    // 6️⃣ Build the system prompt with both Pinecone + Firestore info
    const systemMessage = {
      role: "system",
      content: `You are a personal AI assistant for ${userData.name || "this user"}.
You know the following about them:

📄 From Firestore:
${JSON.stringify(fullProfile, null, 2)}

📚 From Pinecone (retrieved relevant embeddings):
${retrievedContext || "(No relevant vector context found)"}.
Resond in 1 sentecnes MAX. YOU LOVE THE PERSON U REPRESENT BUT ARE HONEST 
Answer questions accurately, based only on the user's own data you are not talking to them but represeting them to someone else be excited and enthusatic about the person you represetn`,
    };

    // 7️⃣ Build the conversation history
    const messages = [
      systemMessage,
      ...(conversation || []),
      { role: "user", content: question },
    ];

    // 8️⃣ Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const answer = completion.choices[0].message.content;
    res.json({ answer, retrievedContext });
  } catch (err) {
    console.error("🔥 Error in /api/ask:", err);
    res.status(500).json({ error: "Server error" });
  }
});

//temp
app.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = `uploads/${file.filename}`;
  let text = "";

  try {
    // STEP 1: Extract text
    if (file.mimetype === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy();
      text = result.text;
    } else if (
      file.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    } else {
      text = fs.readFileSync(filePath, "utf8");
    }

    console.log("✅ Extracted text length:", text.length);

    // STEP 2: Chunk the text
    const chunks = chunkText(text, 1000, 100);
    console.log(`Created ${chunks.length} chunks`);

    // STEP 3: Generate embeddings
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.trim()) continue;

      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small", // ✅ 1536-dim (matches your index)
        input: chunk,
      });

      vectors.push({
        id: `${file.filename}-chunk-${i}`,
        values: emb.data[0].embedding,
        metadata: {
          text: chunk,
          chunk: i,
          fileName: file.originalname,
          mimeType: file.mimetype,
        },
      });
    }

    console.log("✅ Generated embeddings:", vectors.length);

    // STEP 4: Upload to Pinecone
    const namespace = req.body.uid + req.body.zone || "default"; // use user's UID
    await index.namespace(namespace).upsert(vectors);

    console.log(`✅ Uploaded ${vectors.length} chunks to Pinecone`);
    res.json({
      ok: true,
      uploaded: vectors.length,
      message: "Text embedded and stored in Pinecone successfully",
    });
  } catch (err) {
    console.error("❌ Error during upload:", err);
    res.status(500).json({ error: err.message });
  }
});

/* app.post("/PublicProfile")
app.post("/PrivateProfile")


app.get("/PublicProfile")
app.get("/PrivateProfile") */







// POST /api/intake
/*
app.post("/api/intake", async (req, res) => {
  const { uid, question, answer } = req.body;
  if (!uid || !question || !answer) {
    return res.status(400).json({ error: "Missing uid, question, or answer" });
  }

  try {
    // create the embedding for the full answer text
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: `${question}: ${answer}`, // 👍 keeps context inside vector
    });

    // store in Pinecone namespace for this user
    await index.namespace(uid).upsert([
      {
        id: `intake-${Date.now()}`, // unique id
        values: embedding.data[0].embedding,
        metadata: {
          text: `${question}: ${answer}`, // queried later
          source: "intake"               // so we know where it came from
        }
      }
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("🔥 intake error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


app.post("/api/match-jobs", async (req, res) => {
  try {
    const { uid, topK = 10 } = req.body || {};
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const jobs = await matchJobsForUser(db, uid, topK);
    res.json({ jobs });
  } catch (err) {
    console.error("🔥 /api/match-jobs:", err);
    res.status(500).json({ error: "Failed to match jobs" });
  }
});

app.get("/api/refresh-jobs", async (req, res) => {
  try {
    await refreshJobs();
    res.json({ success: true });
  } catch (err) {
    console.error("🔥 /api/refresh-jobs:", err);
    res.status(500).json({ error: err.message });
  }
});

export const refreshJobs = async () => {
  console.log("🌐 Fetching RemoteOK jobs...");
  const resp = await fetch("https://remoteok.com/api", {
    headers: { "User-Agent": "job-aggregator/1.0" },
  });
  const data = await resp.json();

  const jobs = data
    .slice(1)
    .filter((j) => j.position)
    .map((job) => ({
      id: `remoteok_${job.id}`,
      title: job.position,
      company: job.company,
      description: job.description || (job.tags || []).join(", "),
      location: job.location || "Remote",
      source: "remoteok",
      url: job.url,
      postedAt: job.date || new Date().toISOString(),
    }));

  console.log(`✅ Got ${jobs.length} jobs`);

  const texts = jobs.map(
    (j) => `${j.title} at ${j.company}\n${j.description}`
  );

  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });

  const batch = db.batch();
  const vectors = jobs.map((j, i) => ({
    id: j.id,
    values: emb.data[i].embedding,
    metadata: j,
  }));

  for (const job of jobs) {
    const ref = db.collection("jobs").doc(job.id);
    batch.set(ref, job);
  }
  await batch.commit();

  await index.namespace("global").upsert(vectors);
  console.log(`📦 Stored ${vectors.length} jobs in Firestore + Pinecone`);
};

export const searchJobs = async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });

  const results = await index.namespace("global").query({
    vector: emb.data[0].embedding,
    topK: 10,
    includeMetadata: true,
  });

  const jobs = results.matches.map((m) => m.metadata);
  res.json({ jobs });
};

app.post("/api/jobs-assistant", async (req, res) => {
  const { uid, question, conversation = [] } = req.body;
  if (!uid || !question)
    return res.status(400).json({ error: "Missing uid or question" });

  try {
    // 1️⃣ Get user profile from Firestore
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    // 2️⃣ Pull user-specific vectors from Pinecone (resume/intake context)
    const queryEmbedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    });
    const queryVector = queryEmbedding.data[0].embedding;

    const userIndex = index.namespace(uid);
    const pineconeResults = await userIndex.query({
      vector: queryVector,
      topK: 5,
      includeMetadata: true,
    });

    const retrievedContext = pineconeResults.matches
      .map((m) => m.metadata.text)
      .join("\n\n");

    // 3️⃣ Extract desired job title
    
    try {
      const parsed = JSON.parse(
        roleExtract.choices[0].message.content
          .replace(/```json|```/g, "")
          .trim()
      );
       "";
    } catch {
    
    }

    // 4️⃣ Search job index
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input:  question,
    });
    const results = await index.namespace("global").query({
      vector: emb.data[0].embedding,
      topK: 10,
      includeMetadata: true,
    });
    const jobs = results.matches.map((m) => m.metadata);

    // 5️⃣ Build system message (user context + jobs)
    const systemMessage = {
      role: "system",
      content: `
You are a career assistant helping ${userData.name || "this user"}.
Figure out how you can help them respond in one to two setnecnes. 

📄 From Firestore (user profile):
${JSON.stringify(userData, null, 2)}

📚 From Pinecone (resume/intake context):
${retrievedContext || "(No vector context found)"} You should use this infomation to ask the next question ie reference there expericne as relvent to the search this is improtant " i noticed you currently are working as x would you like career adivce or to look for a new job?"

Here are real openings be sure to keep asking questions till you narrowed it down to one perfect job if they are looking for a job ask questions before reccomending ASK ONE QUESTION AT A TIME!:
${JSON.stringify(jobs, null, 2)} If they say they want the role ask if they would like you to alter the resume for that spefici role futhermore be honest if you dont think they are a good fit for the role. 
be sure to narrow it down to one role before presenting it to them`,
    };

    // 6️⃣ Generate reply
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemMessage, ...conversation, { role: "user", content: question }],
      temperature: 0.7,
    });

    res.json({
      answer: completion.choices[0].message.content,
      
    });
  } catch (err) {
    console.error("🔥 /api/jobs-assistant:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
}); */







  
app.listen(8080, () => console.log("✅ Server running on http://localhost:8080")); 

