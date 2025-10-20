import mineflayer = require("mineflayer");
import {
  FunctionDeclaration,
  FunctionDeclarationSchemaType,
} from "@google-cloud/vertexai";
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import mcData from 'minecraft-data';

interface Action {
  act: () => Promise<void>;
  cancel: () => Promise<void>;
  toJSON: () => any;
}

export class MoveToPositionAction implements Action {
  public static FUNCTION_DELCLARATION: FunctionDeclaration = {
    name: "move_to_position",
    description: "Move to a position.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        x: { type: FunctionDeclarationSchemaType.NUMBER },
        y: { type: FunctionDeclarationSchemaType.NUMBER },
        z: { type: FunctionDeclarationSchemaType.NUMBER },
      },
      required: ["x", "y", "z"],
    },
  };

  private static readonly APPROACH_RANGE = 1;
  private static readonly MOVE_TIMEOUT = 30000;

  constructor(
    private bot: mineflayer.Bot,
    private x: number,
    private y: number,
    private z: number,
  ) {}

  public async act() {
    this.bot.chat(`Moving to (${this.x}, ${this.y}, ${this.z})`);
    this.bot.pathfinder.setGoal(
      new goals.GoalNear(
        this.x,
        this.y,
        this.z,
        MoveToPositionAction.APPROACH_RANGE,
      ),
    );
    await new Promise<void>((resolve, reject) => {
      this.bot.once("goal_reached", () => resolve());
      setTimeout(
        () => reject(new Error("Move timeout")),
        MoveToPositionAction.MOVE_TIMEOUT,
      );
    });
  }

  public async cancel() {
    if (this.bot.pathfinder.goal) {
      this.bot.pathfinder.setGoal(null);
      await new Promise<void>((resolve) => {
        this.bot.once("path_reset", () => resolve());
      });
    }
  }

  public toJSON() {
    return {
      action: "move_to_position",
      args: {
        x: this.x,
        y: this.y,
        z: this.z,
      },
    };
  }
}

export class EatAction implements Action {
  public static FUNCTION_DELCLARATION: FunctionDeclaration = {
    name: "eat",
    description: "Eat an item from inventory by name.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        itemName: { type: FunctionDeclarationSchemaType.STRING },
      },
      required: ["itemName"],
    },
  };

  constructor(
    private bot: mineflayer.Bot,
    private itemName: string,
  ) {}

  public async act() {
    this.bot.chat(`Eating ${this.itemName}`);
    let item = this.bot.inventory.items().find((i) => i.name === this.itemName);
    if (item) {
      console.log(`[bot] ${this.bot.username} eating ${this.itemName}`);
      await this.bot.equip(item, "hand");
      await this.bot.consume();
    } else {
      console.log(
        `[bot] ${this.bot.username} cannot eat ${this.itemName}: not in inventory`,
      );
      throw new Error(`Item ${this.itemName} not found in inventory`);
    }
  }

  public async cancel() {
    // Eating cannot be cancelled
  }

  public toJSON() {
    return {
      action: "eat",
      args: {
        itemName: this.itemName,
      },
    };
  }
}

export class FollowAndAttackAction implements Action {
  public static FUNCTION_DELCLARATION: FunctionDeclaration = {
    name: "follow_and_attack",
    description: "Follow and attack an entity by its ID.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        entityId: { type: FunctionDeclarationSchemaType.NUMBER },
      },
      required: ["entityId"],
    },
  };

  private static readonly FOLLOW_DISTANCE = 1;
  private static readonly ATTACK_RANGE = 3;

  private attackTick: () => void = () => {};

  constructor(
    private bot: mineflayer.Bot,
    private entityId: number,
  ) {}

  public async act() {
    this.bot.chat(`Following and attacking entity ${this.entityId}`);
    let entity = this.bot.entities[this.entityId];
    if (entity) {
      console.log(
        `[bot] ${this.bot.username} following and attacking entity ${this.entityId}`,
      );
      this.bot.pathfinder.setGoal(
        new goals.GoalFollow(entity, FollowAndAttackAction.FOLLOW_DISTANCE),
        true,
      );
    } else {
      console.log(
        `[bot] ${this.bot.username} cannot find entity ${this.entityId} to follow and attack`,
      );
      throw new Error(`Entity ${this.entityId} not found`);
    }
    await new Promise<void>((resolve) => {
      this.attackTick = () => {
        if (!entity || !entity.isValid) {
          this.bot.pathfinder.setGoal(null);
          this.bot.removeListener("physicsTick", this.attackTick);
          resolve();
          return;
        }
        let dist = this.bot.entity.position.distanceTo(entity.position);
        if (dist <= FollowAndAttackAction.ATTACK_RANGE) {
          try {
            this.bot.attack(entity);
          } catch {}
        }
      };
      this.bot.on("physicsTick", this.attackTick);
    });
  }

  public async cancel() {
    this.bot.removeListener("physicsTick", this.attackTick);
    if (this.bot.pathfinder.goal) {
      this.bot.pathfinder.stop();
      await new Promise<void>((resolve) => {
        this.bot.once("path_reset", () => resolve());
      });
    }
  }

  public toJSON() {
    return {
      action: "follow_and_attack",
      args: {
        entityId: this.entityId,
      },
    };
  }
}

export class DigBlockAction implements Action {
  public static FUNCTION_DELCLARATION: FunctionDeclaration = {
    name: "dig_block",
    description: "Dig a block at the specified coordinates.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        x: { type: FunctionDeclarationSchemaType.NUMBER },
        y: { type: FunctionDeclarationSchemaType.NUMBER },
        z: { type: FunctionDeclarationSchemaType.NUMBER },
      },
      required: ["x", "y", "z"],
    },
  };

  private static readonly APPROACH_RANGE = 4;
  private static readonly MOVE_TIMEOUT = 30000;

  constructor(
    private bot: mineflayer.Bot,
    private x: number,
    private y: number,
    private z: number,
  ) {}

  public async act() {
    this.bot.chat(`Digging block at (${this.x}, ${this.y}, ${this.z})`);
    let blockCoord = new Vec3(this.x, this.y, this.z);
    this.bot.pathfinder.setGoal(
      new goals.GoalNear(this.x, this.y, this.z, DigBlockAction.APPROACH_RANGE),
    );
    await new Promise<void>((resolve, reject) => {
      this.bot.once("goal_reached", () => resolve());
      setTimeout(
        () => reject(new Error("Move timeout")),
        DigBlockAction.MOVE_TIMEOUT,
      );
    });
    let block = this.bot.blockAt(blockCoord);
    if (block) {
      await this.bot.dig(block);
    }
    mcData(this.bot.version).itemsByName.oak_planks.id;
  }

  public async cancel() {
    this.bot.stopDigging();
    if (this.bot.pathfinder.goal) {
      this.bot.pathfinder.setGoal(null);
      await new Promise<void>((resolve) => {
        this.bot.once("path_reset", () => resolve());
      });
    }
  }

  public toJSON() {
    return {
      action: "dig_block",
      args: {
        x: this.x,
        y: this.y,
        z: this.z,
      },
    };
  }
}

export class ActionChains {
  private actions: Action[] = [];
  private currentActionIndex: number = 0;

  public constructor(private bot: mineflayer.Bot) {}

  public add(action: Action): ActionChains {
    this.actions.push(action);
    return this;
  }

  public async start() {
    if (this.actions.length === 0) {
      this.bot.chat("No actions to perform.");
    } else {
      this.bot.chat(`Starting ${this.actions.length} actions.`);
    }
    while (this.currentActionIndex < this.actions.length) {
      let action = this.actions[this.currentActionIndex];
      try {
        await action.act();
      } catch (e) {
        console.log(
          `[bot] ${this.bot.username} ${JSON.stringify(action)} failed: ${(e as Error).message}`,
        );
        this.bot.chat(
          `Action ${JSON.stringify(action)} failed: ${(e as Error).message}`,
        );
        await this.reset();
        break;
      }
      this.currentActionIndex++;
    }
  }

  public async reset() {
    if (this.currentActionIndex < this.actions.length) {
      let action = this.actions[this.currentActionIndex];
      try {
        await action.cancel();
      } catch (e) {
        console.log(
          `[bot] ${this.bot.username} failed to cancel action ${JSON.stringify(action)}: ${(e as Error).message}`,
        );
      }
    }
    this.actions = [];
    this.currentActionIndex = 0;
  }

  public toJSON() {
    let res = new Array<any>();
    for (let i = this.currentActionIndex; i < this.actions.length; i++) {
      let action = this.actions[i];
      res.push(action.toJSON());
    }
    return res;
  }
}
