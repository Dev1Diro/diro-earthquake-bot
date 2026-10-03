// Explicit test fixture: no credentials or outbound Discord calls are used.
import { Client, Events } from 'discord.js';

Client.prototype.login = async function () {
  const me = { permissions: { has: () => true } };
  const guild = { id: '111111111111111111', members: { fetchMe: async () => me } };
  this.user = { id: '444444444444444444', setPresence() {} };
  this.application = { commands: { async create() {}, async fetch() { return new Map(); }, async delete() {} } };
  this.channels.fetch = async () => ({ guild, guildId: guild.id, isTextBased: () => true, permissionsFor: () => ({ has: () => true }), async send() { throw new Error('Offline HTTP fixture must not send a message'); } });
  this.isReady = () => true;
  this.emit(Events.ClientReady, this);
  return 'offline-fixture';
};
Client.prototype.destroy = async function () { this.isReady = () => false; };
globalThis.fetch = async () => { throw new Error('Offline HTTP fixture blocks external requests'); };
