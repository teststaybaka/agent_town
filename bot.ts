require("dotenv").config();
import {
  FunctionCallingMode,
  GenerativeModel,
  VertexAI,
} from "@google-cloud/vertexai";
import mineflayer = require("mineflayer");
import { pathfinder, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  ActionChains,
  FollowAndAttackAction,
  EatAction,
  MoveToPositionAction,
} from "./actions";

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
  inWater?: boolean;
  inventoryItems?: Array<{ name: string; count: number }>;
  solidBlocksAroundMe?: Array<{
    x: number;
    y: number;
    z: number;
    type: string;
  }>;
  emptyBlocksAroundMe?: Array<{
    x: number;
    y: number;
    z: number;
    type: string;
  }>;
  entitiesAroundMe?: Array<{
    entityId: number;
    name?: string;
    displayName?: string;
    type: string;
    position: { x: number; y: number; z: number };
    distance?: number;
  }>;
}

class AiBot {
  private static LOOP_INTERVAL_MS = 10000;
  private static SCAN_RADIUS = 10;
  private static AIR_SCAN_RADIUS = 5;
  private static DIRECTIONS = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
  ];

  private model: GenerativeModel;
  private actions = new ActionChains(this.bot);

  constructor(private bot: mineflayer.Bot) {
    let vertex = new VertexAI({
      project: CONFIG.gcpProjectId,
      location: CONFIG.gcpLocation,
    });
    this.model = vertex.getGenerativeModel({
      model: CONFIG.model,
      tools: [
        {
          functionDeclarations: [
            MoveToPositionAction.FUNCTION_DELCLARATION,
            EatAction.FUNCTION_DELCLARATION,
            FollowAndAttackAction.FUNCTION_DELCLARATION,
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
      },
      systemInstruction: {
        role: "system",
        parts: [
          {
            text: [
              "You are a survival-focused Minecraft bot. Stay alive as long as possible.",
              "Avoid water unless necessary.",
              "Stay away from hostile mobs unless you need to attack them for survival. Some enemies have ranged attacks. So keep your distance really far away.",
              "If low on health or hunger, try to eat food from your inventory first.",
              "If low on health or hunger, and no food is available, try walk further to find animals to hunt.",
              "You can move to the position where a food item is located to pick it up.",
              "You will only output actions every 10 seconds. Please chain multiple actions together. They will be executed sequentially.",
              "If no action is needed, do nothing.",
            ].join(" "),
          },
        ],
      },
    });
  }

  private async scan(): Promise<Percept> {
    let headBlock = this.bot.blockAt(
      new Vec3(
        this.bot.entity.position.x,
        this.bot.entity.position.y + this.bot.entity.height * 0.9,
        this.bot.entity.position.z,
      ),
    );
    let center = headBlock.position.floored();
    let solidBlocksAroundMe: Array<{
      x: number;
      y: number;
      z: number;
      type: string;
    }> = [];
    let emptyBlocksAroundMe: Array<{
      x: number;
      y: number;
      z: number;
      type: string;
    }> = [];
    let seen = new Set<string>();
    center;
    let i = 0;
    let queues: Array<{ x: number; y: number; z: number }> = [
      { x: center.x, y: center.y, z: center.z },
    ];
    while (i < queues.length) {
      let pos = queues[i];
      let thisBlock = this.bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
      let dist =
        Math.abs(pos.x - center.x) +
        Math.abs(pos.y - center.y) +
        Math.abs(pos.z - center.z);
      if (dist <= AiBot.SCAN_RADIUS && thisBlock) {
        if (thisBlock.boundingBox === "block") {
          solidBlocksAroundMe.push({
            x: pos.x,
            y: pos.y,
            z: pos.z,
            type: thisBlock.displayName,
          });
        } else if (thisBlock.boundingBox === "empty") {
          if (dist <= AiBot.AIR_SCAN_RADIUS) {
            emptyBlocksAroundMe.push({
              x: pos.x,
              y: pos.y,
              z: pos.z,
              type: thisBlock.displayName,
            });
          }
          for (let dir of AiBot.DIRECTIONS) {
            let neighbor = {
              x: pos.x + dir.x,
              y: pos.y + dir.y,
              z: pos.z + dir.z,
            };
            let key = `${neighbor.x},${neighbor.y},${neighbor.z}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            queues.push(neighbor);
          }
        }
      }
      i++;
    }
    console.log(
      `[bot] ${this.bot.username} scanned ${solidBlocksAroundMe.length} solid blocks and ${emptyBlocksAroundMe.length} empty blocks around me`,
    );

    return {
      timeOfDay: this.bot.time.timeOfDay,
      isDay: this.bot.time.isDay,
      health: this.bot.health,
      food: this.bot.food,
      oxygenLevel: this.bot.oxygenLevel,
      position: this.bot.entity.position,
      onGround: this.bot.entity.onGround,
      inWater: headBlock?.name === "water",
      inventoryItems: this.bot.inventory.items().map((item) => ({
        name: item.name,
        count: item.count,
      })),
      solidBlocksAroundMe: solidBlocksAroundMe,
      emptyBlocksAroundMe: emptyBlocksAroundMe,
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

  public async act(): Promise<void> {
    let percept = await this.scan();
    this.bot.chat(
      `Status summary: ${percept.health} HP, ${percept.food} food, position at ${JSON.stringify(percept.position)}`,
    );
    console.log(
      `[bot] ${this.bot.username} current actions: ${JSON.stringify(this.actions.toJSON())}`,
    );

    let resp = await this.model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `My current position and observed state: \n${JSON.stringify(percept)}\nMy current actions: \n${JSON.stringify(this.actions)}\nWhat is my next action or sequence of actions?`,
            },
          ],
        },
      ],
      // Let Gemini call functions automatically if it wants
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
    });

    // Parse tool calls (Vertex returns "candidates[].content.parts[].functionCall")
    await this.actions.reset();
    for (let cand of resp.response.candidates ?? []) {
      for (let part of cand?.content?.parts ?? []) {
        if (part.functionCall?.name) {
          this.addAction(part.functionCall.name, part.functionCall.args);
        }
      }
    }
    this.actions.start();

    setTimeout(() => this.act(), AiBot.LOOP_INTERVAL_MS);
  }

  private addAction(name: string, args: any): void {
    console.log(
      `[bot] ${this.bot.username} adding action: ${name} with args ${JSON.stringify(args)}`,
    );
    switch (name) {
      case "move_to_position":
        let x = args.x;
        let y = args.y;
        let z = args.z;
        this.actions.add(new MoveToPositionAction(this.bot, x, y, z));
        break;
      case "eat":
        let itemName = args.itemName;
        this.actions.add(new EatAction(this.bot, itemName));
        break;
      case "follow_and_attack":
        let entityId = args.entityId;
        this.actions.add(new FollowAndAttackAction(this.bot, entityId));
        break;
      default:
        console.log(`[bot] ${this.bot.username} unknown tool call: ${name}`);
    }
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

  bot.once("spawn", async () => {
    console.log("[bot] spawned in world at", bot.entity.position);
    bot.chat("Spawned! I will try to survive.");

    await bot.waitForTicks(40); // ~2 seconds
    let movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    movements.placeCost = 9999;
    bot.pathfinder.setMovements(movements);
    new AiBot(bot).act();
  });

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (/^ping$/i.test(message)) bot.chat("pong");
    if (/^coords$/i.test(message))
      bot.chat(`My coords: ${bot.entity.position.toString()}`);
  });

  bot.on("goal_reached", (g) => console.log("goal_reached:", g));
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
