/**
 * Simple LLM-driven Minecraft agent (survive-first version)
 * - One bot instance per process; no shared memory between bots.
 * - Vertex AI Gemini 2.5 Pro with functionDeclarations to constrain actions.
 * - Actions implemented with mineflayer + mineflayer-pathfinder only.
 *
 * Requirements:
 *   npm i -S mineflayer mineflayer-pathfinder @google-cloud/vertexai dotenv
 *   # Also ensure GOOGLE_APPLICATION_CREDENTIALS is set to a JSON service account key
 *
 * Run:
 *   ts-node agent.ts
 */
import "dotenv/config";
import mineflayer = require("mineflayer");
import {
  FunctionCallingMode,
  FunctionDeclaration,
  FunctionDeclarationSchemaType,
  GenerativeModel,
  VertexAI,
} from "@google-cloud/vertexai";
import { Bot } from "mineflayer";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

// -------------------------
// Config
// -------------------------
const config = {
  host: process.env.HOST,
  port: Number(process.env.PORT),
  username: process.env.BOT_USERNAME,
  auth: process.env.AUTH as "offline" | "microsoft",
  version: process.env.VERSION,
  googleProject: process.env.GCP_PROJECT_ID,
  googleLocation: process.env.GCP_LOCATION,
  model: process.env.GEMINI_MODEL,
};

// -------------------------
// Vertex AI (Gemini) wiring
// -------------------------

/**
 * Action schema (as functionDeclarations) exposed to the model.
 * Keep them small and safe. The agent picks from these only.
 */
const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "say",
    description: "Chat a short message in Minecraft.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        text: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "Short message to say aloud.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "goto",
    description:
      "Walk to an exact block using pathfinding. Keep y sensible (avoid jumping into lava/water).",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        x: { type: FunctionDeclarationSchemaType.NUMBER },
        y: { type: FunctionDeclarationSchemaType.NUMBER },
        z: { type: FunctionDeclarationSchemaType.NUMBER },
        timeoutMs: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: "Optional timeout for this goal.",
        },
      },
      required: ["x", "y", "z"],
    },
  },
  {
    name: "flee_from",
    description:
      "Run away from a hostile at (x,y,z) to reach at least a given distance. Uses pathfinding.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        x: { type: FunctionDeclarationSchemaType.NUMBER },
        y: { type: FunctionDeclarationSchemaType.NUMBER },
        z: { type: FunctionDeclarationSchemaType.NUMBER },
        minDistance: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: "Meters to keep away (e.g., 16).",
        },
      },
      required: ["x", "y", "z", "minDistance"],
    },
  },
  {
    name: "wait",
    description: "Do nothing for a short period (cooldown or observe).",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        ms: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: "Milliseconds to wait (<= 5000 suggested).",
        },
      },
      required: ["ms"],
    },
  },
  {
    name: "eat_from_inventory",
    description:
      "If hungry and we have edible items in inventory, equip a food item and eat it.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        prefer: {
          type: FunctionDeclarationSchemaType.ARRAY,
          items: { type: FunctionDeclarationSchemaType.STRING },
          description:
            "Optional ordered list of item names to try first (e.g. cooked_beef, bread).",
        },
      },
    },
  },
];

type ToolCall =
  | { name: "say"; args: { text: string } }
  | {
      name: "goto";
      args: { x: number; y: number; z: number; timeoutMs?: number };
    }
  | {
      name: "flee_from";
      args: { x: number; y: number; z: number; minDistance: number };
    }
  | { name: "wait"; args: { ms: number } }
  | { name: "eat_from_inventory"; args: { prefer?: string[] } };

type Percept = {
  timeOfDay: number; // 0..23999
  isDay: boolean;
  health: number;
  food: number;
  position: { x: number; y: number; z: number };
  nearestHostile?: {
    kind: string;
    distance: number;
    position: { x: number; y: number; z: number };
  };
  altitude: number;
  inWater: boolean;
  inLava: boolean;
  hasEdible: boolean;
};

class VertexPlanner {
  private model: GenerativeModel;

  constructor() {
    const vertex = new VertexAI({
      project: config.googleProject!,
      location: config.googleLocation,
    });
    this.model = vertex.getGenerativeModel({
      model: config.model,
      // Important: constrain with functionDeclarations (Vertex tools)
      tools: [{ functionDeclarations }],
      // Make the model concise and deterministic-ish for tool use
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 512,
      },
      systemInstruction: {
        role: "system",
        parts: [
          {
            text: [
              "You are a survival-focused Minecraft agent.",
              "Primary rule: stay alive (avoid hostiles, avoid lava/water hazards, avoid fall damage).",
              "Secondary rule: keep hunger up (eat when food <= 14) if food exists in inventory.",
              "Avoid wandering into caves at night unless fleeing.",
              "Prefer simple actions; one tool call at a time or a short sequence.",
              "If a hostile is within 12 blocks, prioritize flee_from to ≥16 blocks away.",
              "If safe and idle, reposition to open, well-lit areas at surface altitude.",
            ].join(" "),
          },
        ],
      },
    });
  }

  /**
   * Ask the model what to do next, given the latest percepts + brief system rules.
   * The model will (ideally) return a function call (tool call).
   */
  async decide(percept: Percept): Promise<ToolCall[]> {
    const prompt = [
      `Current state:`,
      `- timeOfDay=${percept.timeOfDay} (isDay=${percept.isDay})`,
      `- health=${percept.health}, food=${percept.food}`,
      `- pos=(${percept.position.x.toFixed(1)}, ${percept.position.y.toFixed(1)}, ${percept.position.z.toFixed(1)}) alt=${percept.altitude}`,
      `- inWater=${percept.inWater}, inLava=${percept.inLava}, hasEdible=${percept.hasEdible}`,
      percept.nearestHostile
        ? `- hostile: kind=${percept.nearestHostile.kind} dist=${percept.nearestHostile.distance.toFixed(
            1,
          )} at (${percept.nearestHostile.position.x.toFixed(1)}, ${percept.nearestHostile.position.y.toFixed(
            1,
          )}, ${percept.nearestHostile.position.z.toFixed(1)})`
        : `- hostile: none in range`,
      "",
      "Choose a safe action. If nothing urgent, wait 1-3s or reposition a few blocks.",
    ].join("\n");

    const req = {
      contents: [
        { role: "user", parts: [{ text: prompt }] },
      ],
      // Let Gemini call functions automatically if it wants
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
    };

    const resp = await this.model.generateContent(req);
    const out = resp.response;

    // Parse tool calls (Vertex returns "candidates[].content.parts[].functionCall")
    const tools: ToolCall[] = [];
    for (const cand of out?.candidates ?? []) {
      for (const part of cand?.content?.parts ?? []) {
        if (part.functionCall?.name) {
          const name = part.functionCall.name as ToolCall["name"];
          const args = safeJson(part.functionCall.args ?? {}) as any;
          tools.push({ name, args } as ToolCall);
        }
      }
    }

    // If the model produced plain text (no tool), fall back to a small wait
    if (tools.length === 0) {
      tools.push({ name: "wait", args: { ms: 1500 } });
    }

    return tools;
  }
}

function safeJson(v: unknown): unknown {
  try {
    if (typeof v === "string") return JSON.parse(v);
    return v;
  } catch {
    return v;
  }
}

// -------------------------
// Mineflayer setup
// -------------------------

const { GoalBlock, GoalNear } = goals;

function start() {
  console.log(
    `[bot] connecting to ${config.host}:${config.port} (auth=${config.auth}, model=${config.model})...`,
  );

  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version as any,
  });

  bot.loadPlugin(pathfinder);

  const planner = new VertexPlanner();
  let defaultMovements: Movements | null = null;
  let controlLoopActive = false;
  let stopRequested = false;

  bot.on("login", () => {
    console.log("[bot] logged in as", bot.username);
  });

  bot.once("spawn", () => {
    console.log("[bot] spawned at", bot.entity.position);
    bot.chat("I'm alive. Survival mode engaged.");

    defaultMovements = new Movements(bot);
    bot.pathfinder.setMovements(defaultMovements);

    // Kick off the LLM control loop
    controlLoopActive = true;
    (async function loop() {
      while (controlLoopActive && !stopRequested) {
        try {
          const percept = sense(bot);
          const actions = await planner.decide(percept);
          for (const action of actions) {
            await executeTool(bot, action);
          }
        } catch (e: any) {
          console.error("[loop] error:", e?.message || e);
        }
      }
    })();
  });

  bot.on("goal_reached", () => {
    // Light feedback but not spammy
    // bot.chat('Arrived.')
  });

  bot.on("path_update", (r) => {
    if (r.status === "noPath") bot.chat("Can't reach that spot.");
  });

  bot.on("physicTick", () => {
    // Safety walls: if we are burning or in lava/water, briefly stop goal (don’t spam)
    if (bot.isInLava || bot.isInWater) {
      // Cancel current goal to avoid drowning/burning while we wait for planner next step
      bot.pathfinder.setGoal(null as unknown as Goal);
    }
  });

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (/^ping$/i.test(message)) bot.chat("pong");
    if (/^coords$/i.test(message))
      bot.chat(`My coords: ${bot.entity.position.toString()}`);
    if (/^stop$/i.test(message)) {
      bot.chat("Stopping control loop.");
      controlLoopActive = false;
    }
    if (/^start$/i.test(message)) {
      bot.chat("Resuming control loop.");
      if (!controlLoopActive) {
        controlLoopActive = true;
        (async function loop() {
          while (controlLoopActive && !stopRequested) {
            try {
              const percept = sense(bot);
              const actions = await new VertexPlanner().decide(percept);
              for (const action of actions) {
                await executeTool(bot, action);
              }
            } catch (e: any) {
              console.error("[loop] error:", e?.message || e);
            }
          }
        })();
      }
    }
  });

  bot.on("kicked", (reason) => console.log("[bot] kicked:", reason));
  bot.on("error", (err) => console.error("[bot] error:", err.message));
  bot.on("end", () => {
    console.log("[bot] disconnected. Reconnecting in 5s...");
    setTimeout(start, 5000);
  });
}

// -------------------------
// Perception → Tools
// -------------------------

function sense(bot: Bot): Percept {
  const timeOfDay = bot.time?.time ?? 0; // 0..23999
  const isDay = timeOfDay >= 0 && timeOfDay < 12000;
  const pos = bot.entity.position;
  const altitude = pos.y;

  // Find nearest hostile mob
  const hostileNames = new Set([
    "zombie",
    "skeleton",
    "creeper",
    "spider",
    "husk",
    "drowned",
    "enderman",
    "witch",
    "slime",
    "stray",
    "phantom",
    "pillager",
  ]);
  let nearestHostile: Percept["nearestHostile"] | undefined;

  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (e.type === "mob" && e.kind) {
      const k = String(e.kind).toLowerCase();
      if (hostileNames.has(k)) {
        const d = e.position.distanceTo(pos);
        if (!nearestHostile || d < nearestHostile.distance) {
          nearestHostile = {
            kind: e.kind,
            distance: d,
            position: { x: e.position.x, y: e.position.y, z: e.position.z },
          };
        }
      }
    }
  }

  const hasEdible = getFirstEdible(bot) !== null;

  return {
    timeOfDay,
    isDay,
    health: bot.health,
    food: bot.food,
    position: { x: pos.x, y: pos.y, z: pos.z },
    nearestHostile,
    altitude,
    inWater: !!bot.isInWater,
    inLava: !!bot.isInLava,
    hasEdible,
  };
}

async function executeTool(bot: Bot, call: ToolCall): Promise<void> {
  switch (call.name) {
    case "say": {
      const text = (call.args?.text ?? "").toString().slice(0, 120);
      if (text) bot.chat(text);
      return;
    }
    case "wait": {
      const ms = Math.min(Math.max(Number(call.args?.ms ?? 1000), 250), 5000);
      await delay(ms);
      return;
    }
    case "eat_from_inventory": {
      await tryEat(bot, call.args?.prefer ?? []);
      return;
    }
    case "goto": {
      const { x, y, z } = call.args;
      const timeout = Number(call.args?.timeoutMs ?? 8000);
      await goto(bot, new Vec3(x, y, z), timeout);
      return;
    }
    case "flee_from": {
      const { x, y, z, minDistance } = call.args;
      await fleeFrom(
        bot,
        new Vec3(x, y, z),
        Math.max(8, Number(minDistance) || 16),
      );
      return;
    }
    default:
      return;
  }
}

async function goto(bot: Bot, target: Vec3, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const goal = new GoalBlock(
    Math.floor(target.x),
    Math.floor(target.y),
    Math.floor(target.z),
  );
  bot.pathfinder.setGoal(goal);

  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const done =
        (bot.pathfinder.isMoving() === false &&
          bot.pathfinder.goal() === null) ||
        bot.entity.position.distanceTo(target) < 1.2;
      const timedOut = Date.now() - start > timeoutMs;
      if (done || timedOut) {
        clearInterval(iv);
        bot.pathfinder.setGoal(null as unknown as Goal);
        resolve();
      }
    }, 200);
  });
}

async function fleeFrom(
  bot: Bot,
  dangerPos: Vec3,
  minDistance: number,
): Promise<void> {
  const me = bot.entity.position;
  const dx = me.x - dangerPos.x;
  const dz = me.z - dangerPos.z;
  const len = Math.max(Math.hypot(dx, dz), 0.001);
  const nx = dx / len;
  const nz = dz / len;

  // Try a point minDistance away, keep Y the same to avoid bad drops
  const target = new Vec3(
    Math.round(me.x + nx * minDistance),
    Math.round(me.y),
    Math.round(me.z + nz * minDistance),
  );
  const goal = new GoalNear(target.x, target.y, target.z, 2);
  bot.pathfinder.setGoal(goal);

  // Wait a few seconds or until sufficiently far
  const start = Date.now();
  const timeout = 6000;
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const dist = bot.entity.position.distanceTo(dangerPos);
      const timedOut = Date.now() - start > timeout;
      if (dist >= minDistance || timedOut) {
        clearInterval(iv);
        bot.pathfinder.setGoal(null as unknown as goals.Goal);
        resolve();
      }
    }, 200);
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function getFirstEdible(bot: Bot, prefer: string[] = []) {
  // Prioritize preferred names, fall back to any food-like item names
  const inv = bot.inventory.items();
  const byName = (name: string) => inv.find((i) => i.name === name) || null;

  for (const name of prefer) {
    const item = byName(name);
    if (item) return item;
  }

  const likely = [
    "cooked_beef",
    "cooked_porkchop",
    "cooked_mutton",
    "cooked_chicken",
    "bread",
    "baked_potato",
    "carrot",
    "apple",
    "pumpkin_pie",
    "beetroot_soup",
    "mushroom_stew",
    "cookie",
  ];
  for (const name of likely) {
    const item = byName(name);
    if (item) return item;
  }
  return null;
}

async function tryEat(bot: Bot, prefer: string[] = []) {
  if (bot.food >= 18) return; // Save food
  const item = getFirstEdible(bot, prefer);
  if (!item) {
    bot.chat("I have no food to eat.");
    return;
  }
  try {
    await bot.equip(item, "hand");
    // mineflayer >=4: bot.consume() exists; fallback to activate/deactivate if needed
    if (typeof (bot as any).consume === "function") {
      await (bot as any).consume();
    } else {
      bot.activateItem();
      await delay(2000);
      bot.deactivateItem();
    }
    bot.chat("Ate some food.");
  } catch (e: any) {
    console.error("[eat] failed:", e?.message || e);
  }
}

// -------------------------
// Boot
// -------------------------
start();
