import "dotenv/config";
import {
  FunctionCallingMode,
  FunctionDeclarationSchemaType,
  Tool,
  VertexAI,
} from "@google-cloud/vertexai";

let toolDecl: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "move_to",
        description: "Move to a safe nearby block coordinate.",
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {
            x: { type: FunctionDeclarationSchemaType.NUMBER },
            y: { type: FunctionDeclarationSchemaType.NUMBER },
            z: { type: FunctionDeclarationSchemaType.NUMBER },
          },
          required: ["x", "y", "z"],
        },
      },
      {
        name: "flee_from",
        description:
          "Flee away from a threat by choosing an opposite direction target point.",
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {
            threatX: { type: FunctionDeclarationSchemaType.NUMBER },
            threatY: { type: FunctionDeclarationSchemaType.NUMBER },
            threatZ: { type: FunctionDeclarationSchemaType.NUMBER },
            minDistance: { type: FunctionDeclarationSchemaType.NUMBER },
          },
          required: ["threatX", "threatY", "threatZ"],
        },
      },
      {
        name: "eat_now",
        description: "Eat a food item from inventory if hunger is low.",
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: {},
        },
      },
      {
        name: "say",
        description: "Say a short status message to chat.",
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: { text: { type: FunctionDeclarationSchemaType.STRING } },
          required: ["text"],
        },
      },
      {
        name: "idle",
        description: "Do nothing for a short while if safe.",
        parameters: {
          type: FunctionDeclarationSchemaType.OBJECT,
          properties: { ms: { type: FunctionDeclarationSchemaType.NUMBER } },
        },
      },
    ],
  },
];

async function main() {
  let vertexai = new VertexAI({
    project: process.env.GCP_PROJECT_ID,
    location: process.env.GCP_LOCATION,
  });

  let generativeModel = vertexai.getGenerativeModel({
    model: process.env.GEMINI_MODEL,
    generationConfig: {
      // temperature: 0,          // deterministic plans
      maxOutputTokens: 1024,
    },
    systemInstruction: {
      role: "system",
      parts: [
        {
          text: [
            "You are a Minecraft survival planner for a Mineflayer bot.",
            "Primary directive: KEEP THE BOT ALIVE.",
            "Never roleplay, never explain—respond ONLY by calling allowed functions.",
            "Preferences: avoid water/lava, avoid fall damage, flee from hostiles, eat when hungry, stay in safe lighted areas.",
            "If nothing urgent, idle or reposition to a safe nearby block.",
          ].join(" "),
        },
      ],
    },
  });
  let prompt = [
    "Plan one immediate survival action.",
    "If a hostile is within 10 blocks, flee_from it.",
    "If hunger < 12 and foodCount > 0, eat_now.",
    "If in water or on magma/lava, move_to a safer nearby block (same Y or +1).",
    "If safe, you may idle briefly or reposition with move_to.",
    "Always choose the minimal, safest next action; never chain multiple steps.",
  ].join(" ");
  let res = await generativeModel.generateContent({
    tools: toolDecl,
    toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  });
  console.log(JSON.stringify(res.response));

  // const chat = generativeModel.startChat({
  //   tools: toolDecl,
  //   toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
  // });
}

main();
