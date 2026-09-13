// Made by Ayliee, All rights are reserved to AeroX Development

import { MinecraftBot } from './MinecraftBot.js';
import { msg, msgList } from './ui.js';

// Fixed password for ALL cracked bots
const CRACKED_BOT_PASSWORD = 'bots1234';

export class BotManager {
  constructor() {
    // Map key:
    // username@host
    // or msa:discordId@host before premium login
    this.bots = new Map();
  }

  // =========================
  // CRACKED BOT
  // =========================

  joinCracked(options, channel) {
    const key = `${options.username}@${options.host}`;

    if (this.bots.has(key)) {
      return channel.send(
        msg(
          `**${options.username}** is already active on **${options.host}**`
        )
      );
    }

    const bot = new MinecraftBot(
      {
        ...options,
        auth: 'offline'
      },
      channel,

      // When bot is removed
      () => {
        this.bots.delete(key);
      },

      // Not needed for cracked bot
      null,

      // Fixed AuthMe password
      CRACKED_BOT_PASSWORD
    );

    this.bots.set(key, bot);

    bot.connect().catch((err) => {
      console.error(
        '[BotManager] joinCracked connect error:',
        err
      );
    });
  }

  // =========================
  // PREMIUM BOT
  // =========================

  joinPremium(discordUserId, options, channel) {
    const alreadyRunning = [
      ...this.bots.values()
    ].some(
      (b) =>
        b.options.host === options.host &&
        (
          b.options.username === discordUserId ||
          b.discordUserId === discordUserId
        )
    );

    if (alreadyRunning) {
      return channel.send(
        msg(
          `You already have a premium bot on **${options.host}**`
        )
      );
    }

    let currentKey =
      `msa:${discordUserId}@${options.host}`;

    const bot = new MinecraftBot(
      {
        ...options,
        username: discordUserId,
        auth: 'microsoft'
      },
      channel,

      () => {
        this.bots.delete(currentKey);
      },

      (realUsername) => {
        this.bots.delete(currentKey);

        currentKey =
          `${realUsername}@${options.host}`;

        this.bots.set(currentKey, bot);
      }
    );

    bot.discordUserId = discordUserId;

    this.bots.set(currentKey, bot);

    bot.connect().catch((err) => {
      console.error(
        '[BotManager] joinPremium connect error:',
        err
      );
    });
  }

  // =========================
  // REMOVE BOT
  // =========================

  removeBot(username, host, channel) {
    const exactKey =
      `${username}@${host}`;

    if (this.bots.has(exactKey)) {
      this.bots.get(exactKey).stop();

      this.bots.delete(exactKey);

      return channel.send(
        msg(
          `**${username}** disconnected from **${host}**`
        )
      );
    }

    for (const [key, bot] of this.bots.entries()) {
      if (
        bot.options.host === host &&
        (
          bot.realUsername === username ||
          bot.options.username === username
        )
      ) {
        bot.stop();

        this.bots.delete(key);

        return channel.send(
          msg(
            `**${username}** disconnected from **${host}**`
          )
        );
      }
    }

    return channel.send(
      msg(
        `no bot named **${username}** on **${host}**`
      )
    );
  }

  // =========================
  // JUMP
  // =========================

  jump(username, host, channel) {
    const exactKey =
      `${username}@${host}`;

    if (this.bots.has(exactKey)) {
      this.bots.get(exactKey).jump();
      return;
    }

    for (const bot of this.bots.values()) {
      if (
        bot.options.host === host &&
        (
          bot.realUsername === username ||
          bot.options.username === username
        )
      ) {
        bot.jump();
        return;
      }
    }

    channel.send(
      msg(
        `no bot named **${username}** on **${host}**`
      )
    );
  }

  // =========================
  // SAY
  // =========================

  say(username, host, text, channel) {
    const exactKey =
      `${username}@${host}`;

    if (this.bots.has(exactKey)) {
      this.bots.get(exactKey).say(text);
      return;
    }

    for (const bot of this.bots.values()) {
      if (
        bot.options.host === host &&
        (
          bot.realUsername === username ||
          bot.options.username === username
        )
      ) {
        bot.say(text);
        return;
      }
    }

    channel.send(
      msg(
        `no bot named **${username}** on **${host}**`
      )
    );
  }

  // =========================
  // STATUS
  // =========================

  getStatus() {
    if (this.bots.size === 0) {
      return msg('no active bots');
    }

    const rows = [
      ...this.bots.values()
    ].map((bot) => {
      const name =
        bot.realUsername ||
        bot.options.username;

      const state =
        bot.bot?.entity
          ? 'online'
          : 'connecting';

      return (
        `**${name}** — ` +
        `${bot.options.host}:${bot.options.port} — ` +
        `${state}`
      );
    });

    const count = rows.length;

    return msgList(
      '**Active Bots**',
      rows,
      `-# ${count} bot${count === 1 ? '' : 's'} running`
    );
  }
}
