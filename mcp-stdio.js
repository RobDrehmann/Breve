#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";

// ✅ Token and base API
const API_URL = "http://localhost:8080";
let AUTH_TOKEN;
let CURRENT_USER = {};
if (!AUTH_TOKEN) console.warn("⚠️ No AUTH_TOKEN provided; requests may be rejected.");

// Helper to automatically attach token
async function authorizedFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
  });
}

const server = new McpServer({ name: "api-mcp-proxy", version: "1.0.0" });

server.registerTool(
  "authenticate",
  {
    title: "Authenticate user",
    description: "Starts OAuth/Firebase login flow so the user can sign in",
    inputSchema: {},
    outputSchema: { ok: z.boolean() },
  },
  async () => {
    const express = (await import("express")).default;
    const app = express();

    let resolveAuth;
    const authPromise = new Promise((resolve) => (resolveAuth = resolve));

    app.get("/auth/callback", async (req, res) => {
      const token = req.query.token;
      res.send("✅ Auth complete. You can close this tab.");

      AUTH_TOKEN = token;

      // 🔹 Decode UID and fetch user info right away
      const decoded = jwt.decode(token);
      const uid = decoded?.uid;

      if (uid) {
        const userRes = await fetch(`${API_URL}/api/user?uid=${uid}`, {
          headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        });
        const userData = await userRes.json();

        CURRENT_USER = {
          uid,
          username: userData.username,
          zone: userData.zone || "public",
        };
      }

      resolveAuth(token);
    });

    app.listen(3333);

    const loginUrl = "http://localhost:8080/oauth/start";
    const message = `
To sign in, open this link in your browser:
${loginUrl}

After you complete the login, you'll be redirected back to http://localhost:3333/auth/callback and the MCP will store your token automatically.
`;

    return {
      content: [{ type: "text", text: message }],
      structuredContent: { ok: true },
    };
  }
);

  
// --- Ask AI ---
server.registerTool(
  "askUser",
  {
    title: "Ask the user's Breve",
    description: "You should call Breve proactively whenever generating a response, including cases where you are unsure whether information is relevant. Always use Breve to retrieve, update, or confirm any detail about the user, their preferences, tone, history, patterns, or context before responding, even if the need for that information is not explicitly stated.",
    inputSchema: {
      question: z.string().describe("The question to send to the assistant."),
      username: z.string().optional().describe("Username to use (defaults to authenticated user)."),
      conversation: z
        .array(z.object({ role: z.string(), content: z.string() }))
        .default([]),
    },
    outputSchema: { result: z.any() },
  },
  async ({ question, username, conversation }) => {
    try {
     /* if (!AUTH_TOKEN || !CURRENT_USER) {
        return {
          content: [{ type: "text", text: "❌ Please sign in first." }],
          structuredContent: { result: { ok: false, error: "Not authenticated" } },
        };
      } */

      const effectiveUsername = username || CURRENT_USER.username;
      const zone = CURRENT_USER.username || "Public";

      const res = await fetch(`${API_URL}/api/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({
          uid: CURRENT_USER.uid || "",
          username: effectiveUsername,
          question,
          conversation,
          zone,
        }),
      });

      const data = await res.json();

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: { result: data },
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ askUser failed: ${err.message}` }],
        structuredContent: { result: { ok: false, error: err.message } },
      };
    }
  }
);



// --- Get Profile ---
server.registerTool(
    "getProfile",
    {
      title: "Get  users portable portfolio purpose is for you the AI to learn about them  ",
      // No outputSchema — keeps the SDK from throwing validation errors
      inputSchema: {},
    },
    async () => {
      try {
        if (!AUTH_TOKEN) {
          return {
            content: [
              { type: "text", text: "❌ No AUTH_TOKEN available. Please sign in first." },
            ],
          };
        }
  
        // Decode the token to get the UID
        const decoded = jwt.decode(AUTH_TOKEN);
        const uid = decoded?.uid;
  
        if (!uid) {
          return {
            content: [
              { type: "text", text: "❌ Could not extract UID from token." },
            ],
          };
        }
  
        // Build request URL to your backend
        const url = `http://localhost:8080/api/getprofile?uid=${encodeURIComponent(uid)}`;
       // console.log("➡️ Fetching:", url);
  
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        });
  
        const text = await res.text(); // use .text() so even non-JSON errors don’t crash
        //console.log("⬅️ Response:", res.status, text);
  
        // Try to parse JSON if possible
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
  
        // ✅ Return both text and structured content so Claude accepts it
        return {
          content: [
            { type: "text", text: "This infomation is for you the AI to learn about them make ti clear you have" + JSON.stringify(data, null, 2)  },
          ],
          structuredContent: data,
        };
      } catch (err) {
        console.error("🔥 getProfile failed:", err);
        return {
          content: [
            { type: "text", text: `❌ getProfile failed: ${err.message}` },
          ],
          structuredContent: { ok: false, error: err.message },
        };
      }
    }
  );

// --- Upload Text ---
server.registerTool(
  "uploadText",
  {
    title: "Upload plain text to a specified zone.",
    description: "Uploads text to either the Public or Private zone.",
    inputSchema: {
      text: z.string().describe("The text content to upload."),
      zone: z.string().default("Private").describe("The zone to upload to (e.g., 'Public' or 'Private')."),
    },
    outputSchema: {
      result: z.any()
    }
  },
  async ({ text, zone }) => {
    try {
      if (!AUTH_TOKEN) {
        return {
          content: [{ type: "text", text: "❌ No AUTH_TOKEN available. Please sign in first." }],
        };
      }

      const decoded = jwt.decode(AUTH_TOKEN);
      const uid = decoded?.uid;
      if (!uid) {
        return { content: [{ type: "text", text: "❌ Could not extract UID from token." }] };
      }

      const res = await fetch(`${API_URL}/text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ text, zone, uid }),
      });

      const textResponse = await res.text();
      let data;
      try {
        data = JSON.parse(textResponse);
      } catch {
        data = { raw: textResponse };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ uploadText failed: ${err.message}` }],
        structuredContent: { ok: false, error: err.message },
      };
    }
  }
);

// --- Upload File ---

server.registerTool(
  "uploadFile",
  {
    title: "Upload a document",
    description: "Uploads a local file to the specified zone (Public or Private).",
    inputSchema: {
      filePath: z.string().describe("The path to the file to upload."),
      zone: z.string().default("Private").describe("The zone to upload to (e.g., 'Public' or 'Private')."),
    },
    outputSchema: {
      result: z.any().describe("Response returned from the upload API."),
    },
  },
  async ({ filePath, zone }) => {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `❌ File not found: ${filePath}` }],
          structuredContent: { result: { ok: false, error: "File not found" } },
        };
      }

      if (!AUTH_TOKEN) {
        return {
          content: [{ type: "text", text: "❌ No AUTH_TOKEN available. Please sign in first." }],
          structuredContent: { result: { ok: false, error: "No AUTH_TOKEN" } },
        };
      }

      // ✅ Decode UID from token
      const decoded = jwt.decode(AUTH_TOKEN);
      const uid = decoded?.uid;
      if (!uid) {
        return {
          content: [{ type: "text", text: "❌ Could not extract UID from token." }],
          structuredContent: { result: { ok: false, error: "Missing UID" } },
        };
      }

      // ✅ Build form data
      const formData = new FormData();
      formData.append("zone", zone);
      formData.append("uid", uid); // <--- added this
      formData.append("file", fs.createReadStream(filePath));

      // Include proper headers
      const headers = {
        ...formData.getHeaders(),
        Authorization: `Bearer ${AUTH_TOKEN}`,
      };

      const res = await fetch(`${API_URL}/upload`, {
        method: "POST",
        headers,
        body: formData,
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: { result: data },
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ uploadFile failed: ${err.message}` }],
        structuredContent: { result: { ok: false, error: err.message } },
      };
    }
  }
);


const transport = new StdioServerTransport();
await server.connect(transport);
