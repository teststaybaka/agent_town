require("dotenv").config();
import {
  FunctionCallingMode,
  FunctionDeclarationSchemaType,
  GenerativeModel,
  Tool,
  VertexAI,
} from "@google-cloud/vertexai";
import mineflayer = require("mineflayer");
import { pathfinder, Movements, goals } from "mineflayer-pathfinder";

let CONFIG = {
  host: process.env.HOST,
  port: Number(process.env.PORT),
  username: process.env.BOT_USERNAME,
  auth: process.env.AUTH as "offline" | "microsoft",
  version: process.env.VERSION,
  gcpProjectId: process.env.GCP_PROJECT_ID,
  gcpLocation: process.env.GCP_LOCATION,
  model: process.env.GEMINI_MODEL,
};

interface Percept {
  timeOfDay?: number;
  isDay?: boolean;
  health?: number;
  food?: number;
  oxygenLevel?: number;
  position?: { x: number; y: number; z: number };
  onGround?: boolean;
  inventoryItems?: Array<{ name: string; count: number }>;
  blocksAroundMe?: Array<{ x: number; y: number; z: number; type: string }>;
  entitiesAroundMe?: Array<{
    entityId: number;
    name?: string;
    displayName?: string;
    type: string;
    position: { x: number; y: number; z: number };
    distance?: number;
  }>;
}

export class AiBot {
  private static TOOLS: Tool[] = [
    {
      functionDeclarations: [
        {
          name: "move_to_position",
          description: "Move to a position of coordinates (x, y, z).",
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
          name: "eat",
          description: "Eat an item from inventory by name.",
          parameters: {
            type: FunctionDeclarationSchemaType.OBJECT,
            properties: {
              itemName: { type: FunctionDeclarationSchemaType.STRING },
            },
            required: ["itemName"],
          },
        },
        {
          name: "follow_and_attack",
          description: "Follow and attack an entity by its ID.",
          parameters: {
            type: FunctionDeclarationSchemaType.OBJECT,
            properties: {
              entityId: { type: FunctionDeclarationSchemaType.NUMBER },
            },
            required: ["entityId"],
          },
        },
      ],
    },
  ];
  private static LOOP_INTERVAL_MS = 10000;
  private static SENSE_RADIUS = 5;
  private static FOLLOW_RANGE = 1.2;
  private static ATTACK_RANGE = 3;

  private model: GenerativeModel;
  private lastAttackTick: () => void = () => {};

  constructor(private bot: mineflayer.Bot) {
    let vertex = new VertexAI({
      project: CONFIG.gcpProjectId,
      location: CONFIG.gcpLocation,
    });
    this.model = vertex.getGenerativeModel({
      model: CONFIG.model,
      tools: AiBot.TOOLS,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
      },
      systemInstruction: {
        role: "system",
        parts: [
          {
            text: [
              "You are a survival-focused Minecraft agent.",
              "Stay alive by managing health and hunger, avoiding dangers, and hunting animals for food or attacking enemies if necessary.",
              "You cannot dig or build, so always move to an empty block.",
              "Do not move too far each step (within 30 blocks).",
              "If low on health or hunger, and no food is available, walk further to find animals to hunt.",
              "One action at a time.",
              "If no action is needed, do nothing.",
            ].join(" "),
          },
        ],
      },
    });
  }

  private async sense(): Promise<Percept> {
    let blocks: Array<{ x: number; y: number; z: number; type: string }> = [];
    let center = this.bot.entity.position.floored();
    for (let dx = -AiBot.SENSE_RADIUS; dx <= AiBot.SENSE_RADIUS; dx++) {
      for (let dy = -AiBot.SENSE_RADIUS; dy <= AiBot.SENSE_RADIUS; dy++) {
        for (let dz = -AiBot.SENSE_RADIUS; dz <= AiBot.SENSE_RADIUS; dz++) {
          let pos = center.offset(dx, dy, dz);
          blocks.push({
            x: pos.x,
            y: pos.y,
            z: pos.z,
            type: this.bot.blockAt(pos)?.displayName ?? "empty",
          });
        }
      }
    }

    return {
      timeOfDay: this.bot.time.timeOfDay,
      isDay: this.bot.time.isDay,
      health: this.bot.health,
      food: this.bot.food,
      oxygenLevel: this.bot.oxygenLevel,
      position: this.bot.entity.position,
      onGround: this.bot.entity.onGround,
      inventoryItems: this.bot.inventory.items().map((item) => ({
        name: item.name,
        count: item.count,
      })),
      blocksAroundMe: blocks,
      entitiesAroundMe: Object.values(this.bot.entities)
        .filter((e) => e.id !== this.bot.entity.id)
        .map((e) => ({
          entityId: e.id,
          name: e.name,
          displayName: e.displayName,
          type: e.type,
          position: {
            x: e.position.x,
            y: e.position.y,
            z: e.position.z,
          },
          distance: this.bot.entity.position.distanceTo(e.position),
        })),
    };
  }

  public async action(): Promise<void> {
    let percept = await this.sense();
    this.bot.chat(`Status summary: ${percept.health} HP, ${percept.food} food, position at ${JSON.stringify(percept.position)}`);

    let resp = await this.model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `My current position and observed state: \n${JSON.stringify(percept)}\nNote that the info can be a little outdated.\nWhat is my next action?`,
            },
          ],
        },
      ],
      // Let Gemini call functions automatically if it wants
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
    });

    // Parse tool calls (Vertex returns "candidates[].content.parts[].functionCall")
    for (let cand of resp.response.candidates ?? []) {
      for (let part of cand?.content?.parts ?? []) {
        if (part.functionCall?.name) {
          await this.executeToolCall(
            part.functionCall.name,
            part.functionCall.args,
          );
        }
      }
    }

    setTimeout(() => this.action(), AiBot.LOOP_INTERVAL_MS);
  }

  private async executeToolCall(name: string, args: any): Promise<void> {
    this.bot.removeListener("physicsTick", this.lastAttackTick);
    switch (name) {
      case "move_to_position":
        let x = args.x;
        let y = args.y;
        let z = args.z;
        await this.moveTo(x, y, z);
        break;
      case "eat":
        let itemName = args.itemName;
        await this.eat(itemName);
        break;
      case "follow_and_attack":
        let entityId = args.entityId;
        await this.followAndAttack(entityId);
        break;
      default:
        console.log(`[bot] ${this.bot.username} unknown tool call: ${name}`);
    }
  }

  private async moveTo(x: number, y: number, z: number): Promise<void> {
    this.bot.chat(`Moving to (${x}, ${y}, ${z})`);
    this.bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z), false);
  }

  private async eat(itemName: string): Promise<void> {
    this.bot.chat(`Eating ${itemName}`);
    this.bot.pathfinder.stop();
    let item = this.bot.inventory.items().find((i) => i.name === itemName);
    if (item) {
      console.log(`[bot] ${this.bot.username} eating ${itemName}`);
      await this.bot.equip(item, "hand");
      await this.bot.consume();
    } else {
      console.log(
        `[bot] ${this.bot.username} cannot eat ${itemName}: not in inventory`,
      );
    }
  }

  private async followAndAttack(entityId: number): Promise<void> {
    this.bot.chat(`Following and attacking entity ${entityId}`);
    let entity = this.bot.entities[entityId];
    if (entity) {
      console.log(
        `[bot] ${this.bot.username} following and attacking entity ${entityId}`,
      );
      this.bot.pathfinder.setGoal(
        new goals.GoalFollow(entity, AiBot.FOLLOW_RANGE),
        true,
      );
    } else {
      console.log(
        `[bot] ${this.bot.username} cannot follow and attack entity ${entityId}: not found`,
      );
      return;
    }
    this.lastAttackTick = () => {
      if (!entity || !entity.isValid) {
        this.bot.pathfinder.stop();
        this.bot.removeListener("physicsTick", this.lastAttackTick);
        return;
      }
      let dist = this.bot.entity.position.distanceTo(entity.position);
      if (dist <= AiBot.ATTACK_RANGE) {
        try {
          this.bot.attack(entity);
        } catch {}
      }
    };
    this.bot.on("physicsTick", this.lastAttackTick);
  }
}

function start() {
  console.log(
    `[bot] connecting to ${CONFIG.host}:${CONFIG.port} (auth=${CONFIG.auth})...`,
  );
  let bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
    version: CONFIG.version,
  });
  bot.loadPlugin(pathfinder);

  bot.on("login", () => {
    console.log("[bot] logged in as", bot.username);
  });

  bot.once("spawn", () => {
    console.log("[bot] spawned in world at", bot.entity.position);
    bot.chat("Spawned! I will try to survive.");

    let movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    movements.placeCost = 9999;
    bot.pathfinder.setMovements(movements);
    new AiBot(bot).action();
  });

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (/^ping$/i.test(message)) bot.chat("pong");
    if (/^coords$/i.test(message))
      bot.chat(`My coords: ${bot.entity.position.toString()}`);
  });

  bot.on("path_update", (r) => {
    console.log("path_update:", {
      status: r.status, // 'success' | 'noPath' | 'partial' | 'timeout'
      nodes: r.path?.length ?? 0,
      time: r.time,
      visited: r.visitedNodes,
    });
  });

  bot.on("goal_reached", (g) => console.log("goal_reached:", g));
  bot.on("goal_updated", (g) => console.log("goal_updated:", g));
  bot.on("path_reset", (reason) => console.log("path_reset:", reason));

  bot.on("kicked", (reason, loggedIn) => {
    console.log("[bot] kicked:", reason);
  });
  bot.on("error", (err) => console.error("[bot] error:", err.message));
  bot.on("end", () => {
    console.log("[bot] disconnected. Reconnecting in 5s...");
    setTimeout(start, 5000);
  });
}

start();
