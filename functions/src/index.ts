import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { GoogleGenAI } from "@google/genai";
import cors from "cors";

// Initialize CORS middleware to allow requests from your frontend
const corsHandler = cors({ origin: true });

// Initialize the GenAI client with the secure key from environment variables
// defineSecret is also an option, but process.env works if set in config
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });

export const geminiProxy = onRequest({ secrets: ["GEMINI_API_KEY"] }, (req, res) => {
  corsHandler(req, res, async () => {
    try {
      const { model, contents, config } = req.body;

      // Call the Gemini API
      const response = await ai.models.generateContent({
        model: model,
        contents: contents,
        config: config
      });

      // Send back the full response object
      res.json(response);
    } catch (error: any) {
      logger.error("Gemini Proxy Error", error);
      res.status(500).send({ error: error.message });
    }
  });
});

export const imagenProxy = onRequest({ secrets: ["GEMINI_API_KEY"] }, (req, res) => {
  corsHandler(req, res, async () => {
    try {
      const { model, prompt, config } = req.body;

      // Call the Imagen API
      const response = await ai.models.generateImages({
        model: model,
        prompt: prompt,
        config: config
      });

      res.json(response);
    } catch (error: any) {
      logger.error("Imagen Proxy Error", error);
      res.status(500).send({ error: error.message });
    }
  });
});