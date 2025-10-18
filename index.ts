require('dotenv').config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 25565),
  username: process.env.BOT_USERNAME || undefined,     // offline username or MS email if set
  auth: process.env.AUTH || 'offline',             // 'offline' or 'microsoft'
  version: process.env.VERSION === 'auto' ? false : process.env.VERSION // false = auto
};

function start() {
  console.log(`[bot] connecting to ${config.host}:${config.port} (auth=${config.auth})...`);
  const bot = mineflayer.createBot(config);
  bot.loadPlugin(pathfinder);

  bot.on('login', () => {
    console.log('[bot] logged in as', bot.username);
  });

  bot.once('spawn', () => {
    console.log('[bot] spawned in world at', bot.entity.position);
    // Say hello (avoid spamming by doing it once on first spawn)
    bot.chat('Spawned! I will now start wandering.');

    const defaultMovements = new Movements(bot);
    bot.pathfinder.setMovements(defaultMovements);

    const center = bot.entity.position.clone();
    const radius = 5;

    function wander() {
      // Pick a random target inside the cube
      const dx = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      const dz = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      const dy = Math.floor(Math.random() * 3) - 1; // little vertical variation

      const target = center.offset(dx, dy, dz);
      bot.chat(`Heading to ${target.x}, ${target.y}, ${target.z}`);

      bot.pathfinder.setGoal(new GoalBlock(target.x, target.y, target.z));

      // After reaching or failing, wait a bit then move again
      setTimeout(wander, 5000 + Math.random() * 5000);
    }

    wander();
  });

  bot.on('goal_reached', goal => {
    bot.chat("Arrived!");
  });

  bot.on('path_update', r => {
    if (r.status === 'noPath') bot.chat("Can't reach that spot.");
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    if (/^ping$/i.test(message)) bot.chat('pong');
    if (/^coords$/i.test(message)) bot.chat(`My coords: ${bot.entity.position.toString()}`);
  });

  bot.on('kicked', (reason, loggedIn) => {
    console.log('[bot] kicked:', reason);
  });
  bot.on('error', (err) => console.error('[bot] error:', err.message));
  bot.on('end', () => {
    console.log('[bot] disconnected. Reconnecting in 5s...');
    setTimeout(start, 5000);
  });
}

start();
