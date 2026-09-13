// Made by Ayliee, All rights are reserved to AeroX Development

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import mineflayer from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { msg, msgSections } from './ui.js';

const FATAL_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET'
]);

const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 15_000;
const ANTI_AFK_INTERVAL_MS = 5_000;
const MC_CHAT_LIMIT = 256;

// Local auth cache
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MS_CACHE_DIR = path.join(__dirname, '..', 'auth-cache');
fs.mkdirSync(MS_CACHE_DIR, { recursive: true });

// Auth-plugin prompt patterns
const REGISTER_PATTERNS = [
  /\/register/i,
  /please register/i,
  /you must register/i,
  /register to (play|continue)/i,
  /use \/reg/i,
];

const LOGIN_PATTERNS = [
  /\/(login|l) /i,
  /please (log\s?in|authenticate)/i,
  /you must (log\s?in|authenticate)/i,
  /use \/log/i,
];

function extractText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';

  let t = node.text || node.translate || '';

  if (Array.isArray(node.extra)) {
    t += node.extra.map(extractText).join('');
  }

  if (Array.isArray(node.with)) {
    t += node.with.map(extractText).join('');
  }

  return t;
}

function parseKickReason(reason) {
  try {
    return extractText(JSON.parse(reason)).trim() || reason;
  } catch {
    return reason;
  }
}

export class MinecraftBot {
  constructor(
    options,
    discordChannel,
    onFatal,
    onRealUsername,
    authPassword
  ) {
    this.options = options;
    this.discordChannel = discordChannel;
    this.onFatal = onFatal;
    this.onRealUsername = onRealUsername;

    this.bot = null;

    this.jumpInterval = null;
    this.lookInterval = null;
    this.reconnectTimeout = null;

    this.isStopping = false;
    this.isFatal = false;
    this.isDisconnecting = false;

    this.reconnectAttempts = 0;
    this.spawnedOnce = false;
    this.realUsername = null;

    // Stable AuthMe password
    this.authPassword =
      authPassword ||
      (Math.random().toString(36).slice(2, 12) + 'Aa1!');
  }

  // --------------------------------------------------
  // Discord message helper
  // --------------------------------------------------

  send(content) {
    this.discordChannel.send(content).catch(() => {});
  }

  // --------------------------------------------------
  // Microsoft authentication
  // --------------------------------------------------

  async _preAuth() {
    try {
      const { default: prismarineAuth } =
        await import('prismarine-auth');

      const { Authflow, Titles } = prismarineAuth;

      const authOptions = {
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo',
        flow: 'live',
      };

      const flow = new Authflow(
        this.options.username,
        MS_CACHE_DIR,
        authOptions,
        (data) => {
          const mins = Math.floor(
            (data.expires_in || 900) / 60
          );

          this.send(
            msgSections(
              `Microsoft login required — **${this.options.host}**`,
              `Open: <${data.verification_uri}>\n\nCode: \`${data.user_code}\``,
              `-# Expires in ${mins} min. Bot joins automatically after sign-in.`
            )
          );
        }
      );

      await flow.getMinecraftJavaToken({
        fetchProfile: false
      });

      return true;

    } catch (err) {
      if (!this.isFatal && !this.isStopping) {
        this.isFatal = true;

        this.send(
          msg(
            `Microsoft authentication failed\n-# ${
              err.message || String(err)
            } · bot removed`
          )
        );

        if (this.onFatal) {
          this.onFatal();
        }
      }

      return false;
    }
  }

  // --------------------------------------------------
  // RESOURCE PACK HANDLING
  // --------------------------------------------------

  _setupResourcePackHandler() {
    if (!this.bot || !this.bot._client) return;

    const client = this.bot._client;

    /*
     * Modern Minecraft resource packs.
     *
     * Some Mineflayer / minecraft-protocol versions don't
     * automatically answer the resource-pack packet correctly.
     *
     * We accept the pack without trying to render the textures.
     */

    client.on('add_resource_pack', (packet) => {
      if (this.isStopping || !this.bot) return;

      console.log('[MC] Resource pack requested');

      const uuid =
        typeof packet.uuid === 'string'
          ? packet.uuid
          : packet.uuid?.toString?.();

      console.log('[MC] Resource pack UUID:', uuid || 'none');

      try {
        client.write('resource_pack_receive', {
          uuid,
          result: 3
        });

        console.log('[MC] Resource pack accepted');

      } catch (err) {
        console.log(
          '[MC] Resource pack accept error:',
          err.message
        );
      }

      /*
       * Tell the server that the pack finished loading.
       * This is useful for servers which wait for the
       * SUCCESSFULLY_LOADED response before continuing.
       */

      setTimeout(() => {
        if (this.isStopping || !this.bot) return;

        try {
          client.write('resource_pack_receive', {
            uuid,
            result: 0
          });

          console.log(
            '[MC] Resource pack marked as loaded'
          );

        } catch (err) {
          console.log(
            '[MC] Resource pack loaded response error:',
            err.message
          );
        }
      }, 1000);
    });

    /*
     * Legacy resource-pack packet.
     * Used by older Minecraft protocol versions.
     */

    client.on('resource_pack_send', (packet) => {
      if (this.isStopping || !this.bot) return;

      console.log(
        '[MC] Legacy resource pack requested'
      );

      try {
        client.write('resource_pack_receive', {
          hash: packet.hash || '',
          result: 3
        });

        console.log(
          '[MC] Legacy resource pack accepted'
        );

      } catch (err) {
        console.log(
          '[MC] Legacy resource pack accept error:',
          err.message
        );
      }

      setTimeout(() => {
        if (this.isStopping || !this.bot) return;

        try {
          client.write('resource_pack_receive', {
            hash: packet.hash || '',
            result: 0
          });

          console.log(
            '[MC] Legacy resource pack marked as loaded'
          );

        } catch (err) {
          console.log(
            '[MC] Legacy resource pack loaded error:',
            err.message
          );
        }
      }, 1000);
    });

    /*
     * Mineflayer-level resourcePack event.
     *
     * If the installed Mineflayer version emits this event,
     * accept it as well.
     */

    this.bot.on('resourcePack', (url, hash) => {
      if (this.isStopping || !this.bot) return;

      console.log(
        '[MC] Mineflayer resourcePack event received:',
        url
      );

      try {
        this.bot.acceptResourcePack();

        console.log(
          '[MC] Mineflayer resource pack accepted'
        );
      } catch (err) {
        console.log(
          '[MC] Mineflayer resource pack accept error:',
          err.message
        );
      }
    });
  }

  // --------------------------------------------------
  // CONNECTION
  // --------------------------------------------------

  async connect() {
    if (this.isStopping || this.isFatal) {
      return;
    }

    this.isDisconnecting = false;

    // Clean old bot instance
    if (this.bot) {
      this.bot.removeAllListeners();

      try {
        this.bot.quit();
      } catch {}

      this.bot = null;
    }

    // Microsoft authentication
    if (this.options.auth === 'microsoft') {
      const ok = await this._preAuth();

      if (!ok) {
        return;
      }
    }

    if (this.isStopping || this.isFatal) {
      return;
    }

    // Mineflayer options
    const botOptions = {
      host: this.options.host,
      port: this.options.port || 25565,
      username: this.options.username,
      auth: this.options.auth || 'offline',
      version: this.options.version || false,

      // Important:
      // Do not make Mineflayer throw every protocol error.
      hideErrors: true,
    };

    console.log(
      `[MC] Connecting to ${botOptions.host}:${botOptions.port}`
    );

    this.bot = mineflayer.createBot(botOptions);

    // --------------------------------------------------
    // Resource pack handler
    // MUST be registered immediately after createBot()
    // --------------------------------------------------

    this._setupResourcePackHandler();

    // Pathfinder
    this.bot.loadPlugin(pathfinder);

    // --------------------------------------------------
    // SPAWN
    // --------------------------------------------------

    this.bot.on('spawn', () => {
      if (this.isStopping || this.isFatal) {
        return;
      }

      this.reconnectAttempts = 0;
      this.isDisconnecting = false;

      const name = this.bot.username;

      this.realUsername = name;

      // Notify BotManager once
      if (!this.spawnedOnce && this.onRealUsername) {
        this.spawnedOnce = true;
        this.onRealUsername(name);
      }

      console.log(
        `[MC] ${name} spawned on ${this.options.host}`
      );

      this.send(
        msg(
          `**${name}** connected to **${this.options.host}**`
        )
      );

      this.startAntiAfk();

      try {
        const defaultMove = new Movements(this.bot);
        this.bot.pathfinder.setMovements(defaultMove);
      } catch (err) {
        console.log(
          '[MC] Pathfinder setup error:',
          err.message
        );
      }
    });

    // --------------------------------------------------
    // SERVER CHAT / AUTH
    // --------------------------------------------------

    this.bot.on('messagestr', (raw) => {
      if (!this.bot || this.isStopping) {
        return;
      }

      console.log('[MC CHAT]', raw);

      const t = raw.toLowerCase();

      // Register
      if (
        REGISTER_PATTERNS.some((p) => p.test(t))
      ) {
        setTimeout(() => {
          if (this.bot && !this.isStopping) {
            console.log('[MC] Sending /register');

            this.bot.chat(
              `/register ${this.authPassword} ${this.authPassword}`
            );
          }
        }, 800);

        return;
      }

      // Login
      if (
        LOGIN_PATTERNS.some((p) => p.test(t))
      ) {
        setTimeout(() => {
          if (this.bot && !this.isStopping) {
            console.log('[MC] Sending /login');

            this.bot.chat(
              `/login ${this.authPassword}`
            );
          }
        }, 800);
      }
    });

    // --------------------------------------------------
    // CHAT RELAY
    // --------------------------------------------------

    this.bot.on('chat', (username, chatMessage) => {
      if (
        !this.bot ||
        username === this.bot.username
      ) {
        return;
      }

      this.discordChannel
        .send(
          `\`${this.bot.username}\` **${username}:** ${chatMessage}`
        )
        .catch(() => {});
    });

    // --------------------------------------------------
    // ERROR
    // --------------------------------------------------

    this.bot.on('error', (err) => {
      if (
        this.isStopping ||
        this.isFatal
      ) {
        return;
      }

      console.log(
        '[MC ERROR]',
        err.code || '',
        err.message || err
      );

      if (FATAL_CODES.has(err.code)) {
        this.isFatal = true;

        const name =
          this.realUsername ||
          this.options.username;

        this.send(
          msg(
            `**${name}** — cannot reach **${this.options.host}**\n-# ${err.code} · bot removed`
          )
        );

        this.stop();

        if (this.onFatal) {
          this.onFatal();
        }
      }
    });

    // --------------------------------------------------
    // KICKED
    // --------------------------------------------------

    this.bot.on('kicked', (reason) => {
      if (
        this.isStopping ||
        this.isFatal ||
        this.isDisconnecting
      ) {
        return;
      }

      this.isDisconnecting = true;

      const name =
        this.bot?.username ||
        this.realUsername ||
        this.options.username;

      const readable = parseKickReason(reason);

      console.log(
        `[MC KICKED] ${readable}`
      );

      this.send(
        msgSections(
          `**${name}** kicked from **${this.options.host}**`,
          `-# ${readable}`
        )
      );

      this.handleDisconnect();
    });

    // --------------------------------------------------
    // END / DISCONNECT
    // --------------------------------------------------

    this.bot.on('end', (reason) => {
      if (
        this.isStopping ||
        this.isFatal ||
        this.isDisconnecting
      ) {
        return;
      }

      this.isDisconnecting = true;

      console.log(
        '[MC END]',
        reason || 'connection closed'
      );

      this.handleDisconnect();
    });
  }

  // --------------------------------------------------
  // RECONNECT
  // --------------------------------------------------

  handleDisconnect() {
    if (
      this.isStopping ||
      this.isFatal
    ) {
      return;
    }

    this.stopAntiAfk();

    const name =
      this.realUsername ||
      this.options.username;

    if (
      this.reconnectAttempts >= MAX_RECONNECTS
    ) {
      this.send(
        msg(
          `**${name}** — max reconnects reached\n-# removed after ${MAX_RECONNECTS} failed attempts`
        )
      );

      this.stop();

      if (this.onFatal) {
        this.onFatal();
      }

      return;
    }

    this.reconnectAttempts++;

    const delaySec =
      RECONNECT_DELAY_MS / 1000;

    this.send(
      msg(
        `**${name}** — reconnecting to **${this.options.host}**\n-# attempt ${this.reconnectAttempts}/${MAX_RECONNECTS} · in ${delaySec}s`
      )
    );

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(
      () => {
        this.connect().catch((err) => {
          console.error(
            '[MinecraftBot] reconnect error:',
            err
          );
        });
      },
      RECONNECT_DELAY_MS
    );
  }

  // --------------------------------------------------
  // ANTI AFK
  // --------------------------------------------------

  startAntiAfk() {
    this.stopAntiAfk();

    // Jump every 5 seconds
    this.jumpInterval = setInterval(() => {
      if (this.bot?.entity) {
        this.bot.setControlState(
          'jump',
          true
        );

        setTimeout(() => {
          if (this.bot) {
            this.bot.setControlState(
              'jump',
              false
            );
          }
        }, 400);
      }
    }, ANTI_AFK_INTERVAL_MS);

    // Rotate view every 30 seconds
    this.lookInterval = setInterval(() => {
      if (this.bot?.entity) {
        const yaw =
          Math.random() *
            Math.PI *
            2 -
          Math.PI;

        const pitch =
          (Math.random() - 0.5) * 1.0;

        this.bot.look(
          yaw,
          pitch,
          false
        );
      }
    }, 30_000);
  }

  stopAntiAfk() {
    if (this.jumpInterval) {
      clearInterval(this.jumpInterval);
      this.jumpInterval = null;
    }

    if (this.lookInterval) {
      clearInterval(this.lookInterval);
      this.lookInterval = null;
    }
  }

  // --------------------------------------------------
  // JUMP COMMAND
  // --------------------------------------------------

  jump() {
    const name =
      this.realUsername ||
      this.options.username;

    if (!this.bot?.entity) {
      this.send(
        msg(
          `**${name}** — not in-game, cannot jump`
        )
      );

      return;
    }

    this.bot.setControlState(
      'jump',
      true
    );

    setTimeout(() => {
      if (this.bot) {
        this.bot.setControlState(
          'jump',
          false
        );
      }
    }, 400);

    this.send(
      msg(`**${name}** jumped`)
    );
  }

  // --------------------------------------------------
  // SAY COMMAND
  // --------------------------------------------------

  say(text) {
    const name =
      this.realUsername ||
      this.options.username;

    if (!this.bot?.entity) {
      this.send(
        msg(
          `**${name}** — not in-game, cannot send message`
        )
      );

      return;
    }

    const truncated =
      text.length > MC_CHAT_LIMIT
        ? text.slice(
            0,
            MC_CHAT_LIMIT
          )
        : text;

    this.bot.chat(truncated);

    this.send(
      msg(
        `**${name}** said: ${truncated}`
      )
    );
  }

  // --------------------------------------------------
  // STOP
  // --------------------------------------------------

  stop() {
    this.isStopping = true;

    this.stopAntiAfk();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.bot) {
      this.bot.removeAllListeners();

      try {
        this.bot.quit();
      } catch {}

      this.bot = null;
    }
  }
                }
