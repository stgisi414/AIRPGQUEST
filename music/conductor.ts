import { GoogleGenAI } from "@google/genai";

export enum MusicScale {
  C_MAJOR_A_MINOR = "C_MAJOR_A_MINOR",
  D_FLAT_MAJOR_B_FLAT_MINOR = "D_FLAT_MAJOR_B_FLAT_MINOR",
  D_MAJOR_B_MINOR = "D_MAJOR_B_MINOR",
  E_FLAT_MAJOR_C_MINOR = "E_FLAT_MAJOR_C_MINOR",
  E_MAJOR_C_SHARP_MINOR = "E_MAJOR_C_SHARP_MINOR",
  F_MAJOR_D_MINOR = "F_MAJOR_D_MINOR",
  G_FLAT_MAJOR_E_FLAT_MINOR = "G_FLAT_MAJOR_E_FLAT_MINOR",
  G_MAJOR_E_MINOR = "G_MAJOR_E_MINOR",
  A_FLAT_MAJOR_F_MINOR = "A_FLAT_MAJOR_F_MINOR",
  A_MAJOR_F_SHARP_MINOR = "A_MAJOR_F_SHARP_MINOR",
  B_FLAT_MAJOR_G_MINOR = "B_FLAT_MAJOR_G_MINOR",
  B_MAJOR_G_SHARP_MINOR = "B_MAJOR_G_SHARP_MINOR"
}

export enum MusicGenerationMode {
  QUALITY = "QUALITY",
  LATENCY = "LATENCY"
}

interface WeightedPrompt {
  text: string;
  weight: number;
}

export interface LyriaConfig {
  weightedPrompts: WeightedPrompt[];
  musicGenerationConfig: {
    bpm: number;
    density: number;
    scale: MusicScale;
    musicGenerationMode: MusicGenerationMode;
  };
}

export async function generateMusicConfig(situation: string, apiKey: string): Promise<LyriaConfig> {
  const genAI = new GoogleGenAI({ apiKey });
  
  const prompt = `
    You are a dynamic music director for a fantasy game. Map the situation to a music configuration.
    
    Current Situation: "${situation}"
    
    Guidance:
    - High danger/combat: High BPM (120-160), High Density (0.7-1.0), Minor keys.
    - Exploration/Town: Moderate BPM (80-110), Moderate Density (0.4-0.6), Major keys.
    - Safe/Rest: Low BPM (60-80), Low Density (0.1-0.3).
    - Prompts should be evocative (e.g., "thundering war drums", "ethereal elven harp").
  `;

  const result = await genAI.models.generateContent({
    model: "gemini-2.5-flash",
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          weightedPrompts: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                text: { type: "STRING" },
                weight: { type: "NUMBER" }
              },
              required: ["text", "weight"]
            }
          },
          musicGenerationConfig: {
            type: "OBJECT",
            properties: {
              bpm: { type: "NUMBER" },
              density: { type: "NUMBER" },
              scale: { type: "STRING", enum: Object.values(MusicScale) },
              musicGenerationMode: { type: "STRING", enum: Object.values(MusicGenerationMode) }
            },
            required: ["bpm", "density", "scale", "musicGenerationMode"]
          }
        },
        required: ["weightedPrompts", "musicGenerationConfig"]
      }
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  });

  // Handle cases where result.text() might be null or undefined safely if needed, 
  // though typed SDK usually guarantees string if successful.
  const responseText = result.text; 
  return JSON.parse(responseText || "{}") as LyriaConfig;
}
