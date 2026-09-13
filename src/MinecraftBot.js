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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MS_CACHE_DIR = path.join(__dirname, '..', 'auth-cache');

fs.mkdirSync(MS_CACHE_DIR, { recursive: true });

// AuthMe messages
const REGISTER_PATTERNS = [
  /\/register/i,
  /please register/i,
  /you must register/i,
  /register to (play|continue)/i,
  /use \/reg/i
];

const LOGIN_PATTERNS = [
  /\/login/i,
  /\/l /i,
  /please (log\s?in|authenticate)/i,
  /you must (log\s?in|authenticate)/i,
  /use \/log/i
];

function extractText(node) {
  if (typeof node === 'string') return node;

  if (!node || typeof node !== 'object') return '';

  let text = node.text || node.translate || '';

  if (Array.isArray(node.extra)) {
    text += node.extra.map(extractText).join('');
  }

  if (Array.isArray(node.with)) {
    text += node.with.map(extractText).join('');
  }

  return text;
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

    // Password comes from BotManager.
    // Fallback is only used if BotManager didn't provide one.
    this.authPassword =
      authPassword ||
      'bots1234';

    this.authRunning = false;
  }

  send(content) {
    this.discordChannel.send(content).catch(() => {});
  }

  async _preAuth() {
    try {
      const { default: prismarineAuth } = await import('prismarine-auth');
      const { Authflow, Titles } = prismarineAuth;

      const authOptions = {
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo',
        flow: 'live'
      };

      const flow = new Authflow(
        this.options.username,
        MS_CACHE_DIR,
        authOptions,
        (data) => {
          const mins = Math.floor((data.expires_in || 900) / 60);

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

  async connect() {
    if (this.isStopping || this.isFatal) return;

    this.isDisconnecting = false;

    if (this.bot) {
      this.bot.removeAllListeners();

      try {
        this.bot.quit();
      } catch {}

      this.bot = null;
    }

    // Premium Microsoft authentication
    if (this.options.auth === 'microsoft') {
      const ok = await this._preAuth();

      if (!ok) return;
    }

    if (this.isStopping || this.isFatal) return;

    const botOptions = {
      host: this.options.host,
      port: this.options.port || 25565,
      username: this.options.username,

      // Cracked = offline
      auth: this.options.auth || 'offline',

      version: this.options.version || false,
      hideErrors: true
    };

    this.bot = mineflayer.createBot(botOptions);

    this.bot.loadPlugin(pathfinder);

    // =========================
    // SPAWN
    // =========================

    this.bot.on('spawn', () => {
      if (this.isStopping || this.isFatal) return;

      this.reconnectAttempts = 0;
      this.isDisconnecting = false;

      const name = this.bot.username;

      this.realUsername = name;

      if (!this.spawnedOnce && this.onRealUsername) {
        this.spawnedOnce = true;
        this.onRealUsername(name);
      }

      this.send(
        msg(`**${name}** connected to **${this.options.host}**`)
      );

      const defaultMove = new Movements(this.bot);

      this.bot.pathfinder.setMovements(defaultMove);

      this.startAntiAfk();

      // Automatically try AuthMe.
      this.startAuth();
    });

    // =========================
    // AUTHME CHAT DETECTION
    // =========================

    this.bot.on('messagestr', (raw) => {
      if (!this.bot || this.isStopping) return;

      const text = String(raw || '');

      this.handleAuthMessage(text);
    });

    // Some servers send messages through the normal "message" event.
    this.bot.on('message', (jsonMsg) => {
      if (!this.bot || this.isStopping) return;

      const text = extractText(jsonMsg);

      this.handleAuthMessage(text);
    });

    // =========================
    // NORMAL CHAT
    // =========================

    this.bot.on('chat', (username, chatMessage) => {
      if (!this.bot || username === this.bot.username) return;

      this.discordChannel
        .send(
          `\`${this.bot.username}\` **${username}:** ${chatMessage}`
        )
        .catch(() => {});
    });

    // =========================
    // ERROR
    // =========================

    this.bot.on('error', (err) => {
      if (this.isStopping || this.isFatal) return;

      if (FATAL_CODES.has(err.code)) {
        this.isFatal = true;

        const name =
          this.realUsername || this.options.username;

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

    // =========================
    // KICK
    // =========================

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

      this.send(
        msgSections(
          `**${name}** kicked from **${this.options.host}**`,
          `-# ${readable}`
        )
      );

      this.handleDisconnect();
    });

    // =========================
    // END
    // =========================

    this.bot.on('end', () => {
      if (
        this.isStopping ||
        this.isFatal ||
        this.isDisconnecting
      ) {
        return;
      }

      this.isDisconnecting = true;

      this.handleDisconnect();
    });
  }

  // =========================
  // AUTHME HANDLER
  // =========================

  handleAuthMessage(text) {
    if (!text || this.isStopping || !this.bot) return;

    const lower = text.toLowerCase();

    // Register request
    if (
      REGISTER_PATTERNS.some((pattern) =>
        pattern.test(lower)
      )
    ) {
      this.sendRegister();
      return;
    }

    // Login request
    if (
      LOGIN_PATTERNS.some((pattern) =>
        pattern.test(lower)
      )
    ) {
      this.sendLogin();
    }
  }

  // =========================
  // REGISTER
  // =========================

  sendRegister() {
    if (!this.bot || this.isStopping) return;

    setTimeout(() => {
      if (!this.bot || this.isStopping) return;

      this.bot.chat(
        `/register ${this.authPassword} ${this.authPassword}`
      );
    }, 800);
  }

  // =========================
  // LOGIN
  // =========================

  sendLogin() {
    if (!this.bot || this.isStopping) return;

    setTimeout(() => {
      if (!this.bot || this.isStopping) return;

      this.bot.chat(
        `/login ${this.authPassword}`
      );
    }, 800);
  }

  // =========================
  // AUTOMATIC AUTH
  // =========================

  startAuth() {
    if (this.authRunning) return;

    this.authRunning = true;

    // First try REGISTER.
    // If account already exists, server will reject register,
    // then LOGIN will authenticate it.

    setTimeout(() => {
      if (!this.bot || this.isStopping) return;

      this.bot.chat(
        `/register ${this.authPassword} ${this.authPassword}`
      );
    }, 2000);

    // Then try LOGIN.
    setTimeout(() => {
      if (!this.bot || this.isStopping) return;

      this.bot.chat(
        `/login ${this.authPassword}`
      );
    }, 4500);

    // Extra login fallback.
    setTimeout(() => {
      if (!this.bot || this.isStopping) return;

      this.bot.chat(
        `/login ${this.authPassword}`
      );
    }, 7000);

    // Allow auth sequence again after reconnect.
    setTimeout(() => {
      this.authRunning = false;
    }, 9000);
  }

  // =========================
  // DISCONNECT / RECONNECT
  // =========================

  handleDisconnect() {
    if (this.isStopping || this.isFatal) return;

    this.stopAntiAfk();

    this.authRunning = false;

    const name =
      this.realUsername || this.options.username;

    if (this.reconnectAttempts >= MAX_RECONNECTS) {
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

    const delaySec = RECONNECT_DELAY_MS / 1000;

    this.send(
      msg(
        `**${name}** — reconnecting to **${this.options.host}**\n-# attempt ${this.reconnectAttempts}/${MAX_RECONNECTS} · in ${delaySec}s`
      )
    );

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {});
    }, RECONNECT_DELAY_MS);
  }

  // =========================
  // ANTI AFK
  // =========================

  startAntiAfk() {
    this.stopAntiAfk();

    this.jumpInterval = setInterval(() => {
      if (this.bot?.entity) {
        this.bot.setControlState('jump', true);

        setTimeout(() => {
          if (this.bot) {
            this.bot.setControlState('jump', false);
          }
        }, 400);
      }
    }, ANTI_AFK_INTERVAL_MS);

    this.lookInterval = setInterval(() => {
      if (this.bot?.entity) {
        const yaw =
          Math.random() * Math.PI * 2 - Math.PI;

        const pitch =
          (Math.random() - 0.5) * 1.0;

        this.bot.look(yaw, pitch, false);
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

  // =========================
  // JUMP COMMAND
  // =========================

  jump() {
    const name =
      this.realUsername || this.options.username;

    if (!this.bot?.entity) {
      this.send(
        msg(`**${name}** — not in-game, cannot jump`)
      );

      return;
    }

    this.bot.setControlState('jump', true);

    setTimeout(() => {
      if (this.bot) {
        this.bot.setControlState('jump', false);
      }
    }, 400);

    this.send(
      msg(`**${name}** jumped`)
    );
  }

  // =========================
  // SAY COMMAND
  // =========================

  say(text) {
    const name =
      this.realUsername || this.options.username;

    if (!this.bot?.entity) {
      this.send(
        msg(`**${name}** — not in-game, cannot send message`)
      );

      return;
    }

    const truncated =
      text.length > MC_CHAT_LIMIT
        ? text.slice(0, MC_CHAT_LIMIT)
        : text;

    this.bot.chat(truncated);

    this.send(
      msg(`**${name}** said: ${truncated}`)
    );
  }

  // =========================
  // STOP
  // =========================

  stop() {
    this.isStopping = true;

    this.stopAntiAfk();

    this.authRunning = false;

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
