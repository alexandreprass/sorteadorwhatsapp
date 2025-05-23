// ----- INÍCIO DO SCRIPT api/index.js -----
console.log('[BOT_DEBUG] Script api/index.js iniciado. Verificando maxDuration e logs detalhados de conexão.');

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_EXCEPTION] ERRO NÃO TRATADO:', error.stack || error);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION] PROMISE REJEITADA E NÃO TRATADA:', reason);
});

const {
  default: makeWASocket,
  DisconnectReason,
  proto,
  initAuthCreds,
  BufferJSON,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { Redis } = require('@upstash/redis');

console.log('[BOT_DEBUG] Módulos importados.');

let redis;
try {
  redis = Redis.fromEnv();
  console.log('[BOT_DEBUG] Cliente Upstash Redis inicializado via fromEnv().');
} catch (e) {
  console.error('[BOT_ERROR] FALHA AO INICIALIZAR REDIS fromEnv():', e);
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[BOT_WARN] Variáveis de ambiente UPSTASH_REDIS_REST_URL e/ou UPSTASH_REDIS_REST_TOKEN NÃO ESTÃO DEFINIDAS!');
  }
}

const PARTICIPANTS_REDIS_KEY = 'draw_participants';
const AUTH_CREDS_REDIS_KEY = 'baileys_auth_creds';
const AUTH_KEYS_REDIS_PREFIX = 'baileys_auth_keys';
console.log('[BOT_DEBUG] Constantes de chaves Redis definidas.');

async function useUpstashAuthState() {
  console.log('[BOT_DEBUG] useUpstashAuthState: Iniciando...');
  const readData = async (key) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.readData: Lendo chave "${key}"`);
    if (!redis) { console.error('[BOT_ERROR] readData: Cliente Redis não inicializado!'); return null; }
    try {
      const dataString = await redis.get(key);
      if (dataString) { return JSON.parse(dataString, BufferJSON.reviver); }
      return null;
    } catch (error) { console.error(`[BOT_ERROR] readData: Falha ao ler/parsear ${key}:`, error); return null; }
  };
  const writeData = async (key, data) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.writeData: Escrevendo chave "${key}"`);
    if (!redis) { console.error('[BOT_ERROR] writeData: Cliente Redis não inicializado!'); return; }
    try { await redis.set(key, JSON.stringify(data, BufferJSON.replacer)); } catch (error) { console.error(`[BOT_ERROR] writeData: Falha ao escrever ${key}:`, error); }
  };
  const removeData = async (key) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.removeData: Removendo chave "${key}"`);
    if (!redis) { console.error('[BOT_ERROR] removeData: Cliente Redis não inicializado!'); return; }
    try { await redis.del(key); } catch (error) { console.error(`[BOT_ERROR] removeData: Falha ao deletar ${key}:`, error); }
  };

  const credsFromDB = await readData(AUTH_CREDS_REDIS_KEY);
  let creds;
  if (credsFromDB) {
    creds = credsFromDB;
    console.log('[BOT_DEBUG] useUpstashAuthState: Credenciais carregadas do DB.');
  } else {
    creds = initAuthCreds();
    console.log('[BOT_DEBUG] useUpstashAuthState: Novas credenciais inicializadas (nada no DB).');
  }
  console.log('[BOT_DEBUG] useUpstashAuthState: Processamento de credenciais concluído.');

  return { 
    state: { creds, keys: { get: async (type, ids) => {const data = {}; for (const id of ids) { const key = `${AUTH_KEYS_REDIS_PREFIX}_${type}_${id}`; let value = await readData(key); if (value) { if (type === 'app-state-sync-key' && value.keyData) { value = proto.Message.AppStateSyncKeyData.fromObject(value); } data[id] = value; } } return data; }, set: async (data) => {const tasks = []; for (const category in data) { for (const id in data[category]) { const value = data[category][id]; const key = `${AUTH_KEYS_REDIS_PREFIX}_${category}_${id}`; if (value) { tasks.push(writeData(key, value)); } else { tasks.push(removeData(key)); } } } await Promise.all(tasks); } } }, saveCreds: async () => { await writeData(AUTH_CREDS_REDIS_KEY, creds); console.log('[BOT_DEBUG] useUpstashAuthState.saveCreds: Credenciais principais salvas.'); }
  };
}

async function startBot() {
  console.log('[BOT_DEBUG] startBot: Iniciando função startBot...');
  if (!redis) {
    console.error('[BOT_ERROR] startBot: Cliente Redis não está disponível. Bot NÃO PODE INICIAR.');
    return; 
  }

  let state, saveCreds;
  try {
    console.log('[BOT_DEBUG] startBot: Chamando useUpstashAuthState...');
    const authResult = await useUpstashAuthState();
    state = authResult.state;
    saveCreds = authResult.saveCreds;
    console.log('[BOT_DEBUG] startBot: useUpstashAuthState retornado.');
  } catch (e) {
    console.error('[BOT_ERROR] startBot: Erro CRÍTICO em useUpstashAuthState:', e);
    return; 
  }

  console.log('[BOT_DEBUG] startBot: Chamando makeWASocket...');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true }); // printQRInTerminal ainda é útil para o Baileys internamente
  console.log('[BOT_DEBUG] startBot: makeWASocket chamado.');

  let participants = [];
  const saveParticipantsToRedis = async () => { console.log('[BOT_DEBUG] saveParticipantsToRedis:', participants.length); try { await redis.set(PARTICIPANTS_REDIS_KEY, participants); } catch (err) { console.error('[BOT_ERROR] saveParticipantsToRedis:', err); } };
  const loadParticipantsFromRedis = async () => { console.log('[BOT_DEBUG] loadParticipantsFromRedis: Carregando...'); try { const data = await redis.get(PARTICIPANTS_REDIS_KEY); if (data && Array.isArray(data)) { participants = data; console.log('[BOT_DEBUG] loadParticipantsFromRedis: Carregados:', participants.length); } else { participants = []; console.log('[BOT_DEBUG] loadParticipantsFromRedis: Nenhum/inválido, iniciando vazio.'); } } catch (err) { participants = []; console.error('[BOT_ERROR] loadParticipantsFromRedis:', err); } };
  await loadParticipantsFromRedis();

  sock.ev.on('connection.update', (update) => {
    console.log('[BOT_CONNECTION_UPDATE_EVENT_FIRED] Evento connection.update disparado.');

    try {
      if (update) {
        console.log(`[BOT_CONNECTION_UPDATE_DETAILS] Connection Status: ${update.connection}`);
        console.log(`[BOT_CONNECTION_UPDATE_DETAILS] QR String no evento: ${update.qr ? 'SIM, existe!' : 'NÃO, ausente ou null.'}`);
        
        if (update.qr) {
          console.log('[BOT_QR_CODE]--------------------------------------------------------------------');
          console.log('[BOT_QR_CODE] STRING ORIGINAL DO QR CODE DO EVENTO:');
          console.log(update.qr); 
          console.log('[BOT_QR_CODE] TENTANDO GERAR ASCII (para referência):');
          try {
            qrcode.generate(update.qr, { small: true });
          } catch (qrGenError) {
            console.error('[BOT_ERROR] Falha ao gerar QR Code ASCII:', qrGenError);
          }
          console.log('[BOT_QR_CODE]--------------------------------------------------------------------');
        }

        if (update.lastDisconnect && update.lastDisconnect.error) {
          const boomError = new Boom(update.lastDisconnect.error);
          console.log(`[BOT_CONNECTION_UPDATE_DETAILS] Erro no LastDisconnect: ${boomError.message}`);
          console.log(`[BOT_CONNECTION_UPDATE_DETAILS] Código de Status do Erro Boom: ${boomError?.output?.statusCode}`);
        }
      } else {
        console.log('[BOT_CONNECTION_UPDATE_WARN] Evento connection.update recebido como null ou undefined.');
      }

      const { connection, lastDisconnect } = update || {}; // Garante que update não seja null aqui

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error ? new Boom(lastDisconnect.error).output?.statusCode : null;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[BOT_INFO] Conexão fechada. Status Baileys: ${statusCode}, Deveria Reconectar: ${shouldReconnect}`);
        
        if (statusCode === DisconnectReason.connectionReplaced) { console.log("[BOT_WARN] Conexão substituída por outra sessão."); } 
        else if (statusCode === DisconnectReason.loggedOut) { console.log("[BOT_WARN] Deslogado do WhatsApp permanentemente."); } 
        else if (shouldReconnect) { 
          console.log('[BOT_INFO] Tentando reconectar em 5 segundos...'); 
          setTimeout(startBot, 5000); 
        }
      } else if (connection === 'open') {
        console.log('[BOT_INFO] BOT CONECTADO COM SUCESSO AO WHATSAPP!');
        console.log('[BOT_DEBUG] ID do Bot (sock.user):', sock.user?.id || 'Ainda não disponível');
      }

    } catch (e) {
      console.error('[BOT_ERROR] ERRO CRÍTICO DENTRO DO HANDLER connection.update:', e.stack || e);
    }
  });

  sock.ev.on('creds.update', async () => { console.log('[BOT_DEBUG] creds.update: Chamando saveCreds...'); try { await saveCreds(); console.log('[BOT_DEBUG] creds.update: saveCreds concluído.'); } catch (e) { console.error('[BOT_ERROR] creds.update: Erro:', e); } });
  sock.ev.on('messages.upsert', async ({ messages }) => { /* ... (código messages.upsert como antes, já tem bons logs) ... */ console.log('[BOT_DEBUG] messages.upsert:', JSON.stringify(messages[0]?.key)); const msg = messages[0]; if (!msg.message || msg.key.fromMe) return; const chatId = msg.key.remoteJid; const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''; const senderId = msg.key.participant || msg.key.remoteJid; console.log(`[BOT_DEBUG] Mensagem: ChatID="${chatId}", SenderID="${senderId}", Texto="${text}"`); if (text.startsWith('@') && text.length > 1) { const participantName = text.slice(1).trim(); if (participantName) { const existingParticipant = participants.find(p => p.id === senderId); if (!existingParticipant) { participants.push({ id: senderId, name: participantName }); await saveParticipantsToRedis(); console.log(`[BOT_INFO] Participante @${participantName} (${senderId}) adicionado.`); try { await sock.sendMessage(chatId, { text: `🎉 @${participantName} foi adicionado ao sorteio!`, mentions: [senderId] }); } catch (e) { console.error(`[BOT_ERROR] Falha msg adição:`, e); } } else { console.log(`[BOT_INFO] @${existingParticipant.name} (${senderId}) já participa.`); try { await sock.sendMessage(chatId, { text: `🚫 @${existingParticipant.name} já está participando!`, mentions: [senderId] }); } catch (e) { console.error(`[BOT_ERROR] Falha msg existente:`, e); } } } else { console.log('[BOT_WARN] @ sem nome válido.'); try { await sock.sendMessage(chatId, { text: '🚫 Nome inválido após @ (ex.: @Joao).', mentions: [senderId] }); } catch (e) { console.error(`[BOT_ERROR] Falha msg nome inválido:`, e); } } } if (text.startsWith('!sortear')) { console.log('[BOT_DEBUG] !sortear detectado.'); const botJid = sock.user?.id; const senderNumericId = senderId.split('@')[0]; const botNumericId = botJid ? botJid.split(':')[0].split('@')[0] : null; if (!botJid || senderNumericId !== botNumericId) { console.log('[BOT_WARN] !sortear negado. Permissão insuficiente.'); try { await sock.sendMessage(chatId, { text: '🚫 Apenas o admin pode usar !sortear.' }); } catch (e) { console.error(`[BOT_ERROR] Falha msg permissão negada:`, e); } return; } console.log('[BOT_DEBUG] Permissão para !sortear OK.'); const args = text.split(' '); let numWinners = 1; if (args.length > 1 && !isNaN(args[1])) { numWinners = parseInt(args[1]); } if (participants.length === 0) { console.log('[BOT_INFO] Sorteio sem participantes.'); try { await sock.sendMessage(chatId, { text: '🚫 Nenhum participante!' }); } catch (e) { console.error(`[BOT_ERROR] Falha msg nenhum participante:`, e); } return; } if (numWinners < 1) {numWinners = 1;} numWinners = Math.min(numWinners, participants.length); const shuffled = [...participants].sort(() => 0.5 - Math.random()); const winners = shuffled.slice(0, numWinners); const winnerMessages = winners.map(w => `@${w.name}`); const winnerJids = winners.map(w => w.id); console.log('[BOT_INFO] Vencedores:', JSON.stringify(winners)); try { await sock.sendMessage(chatId, { text: `🏆 ${numWinners > 1 ? 'Os vencedores são' : 'O vencedor é'}: ${winnerMessages.join(', ')}! Parabéns!`, mentions: winnerJids }); participants = []; await saveParticipantsToRedis(); await sock.sendMessage(chatId, { text: 'Lista de participantes resetada!' }); } catch(e) { console.error(`[BOT_ERROR] Falha msg sorteio/reset:`, e); } } });

  console.log('[BOT_DEBUG] startBot: Handlers de eventos configurados.');
}

console.log('[BOT_DEBUG] Chamando startBot() automaticamente ao carregar o script...');
startBot().catch((err) => {
  console.error('[BOT_FATAL] Erro crítico não tratado na chamada inicial de startBot():', err);
});

console.log('[BOT_DEBUG] ----- FIM DO SETUP INICIAL DO SCRIPT api/index.js -----');

module.exports = (req, res) => {
  console.log(`[BOT_HANDLER] Requisição HTTP recebida: ${req.method} ${req.url}`);
  res.status(200).send('Host do Bot WhatsApp em execução. Verifique os logs da função para status/QR code.');
};
