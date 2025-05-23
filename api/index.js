const {
  default: makeWASocket,
  DisconnectReason,
  proto,
  initAuthCreds,
  BufferJSON, // Essencial para serializar/desserializar o estado do Baileys corretamente
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { Redis } = require('@upstash/redis'); // Importa o cliente Upstash Redis

// Inicializa o cliente Redis usando variáveis de ambiente
// Certifique-se de que UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN estão configuradas no Vercel
const redis = Redis.fromEnv();

// Chaves para o Upstash Redis (pode manter as mesmas ou renomear se preferir)
const PARTICIPANTS_REDIS_KEY = 'draw_participants';
const AUTH_CREDS_REDIS_KEY = 'baileys_auth_creds';
const AUTH_KEYS_REDIS_PREFIX = 'baileys_auth_keys';

// Função para usar Upstash Redis para o estado de autenticação do Baileys
async function useUpstashAuthState() {
  const readData = async (key) => {
    try {
      const dataString = await redis.get(key);
      if (dataString) {
        // Desserializa usando BufferJSON.reviver para tratar Buffers corretamente
        return JSON.parse(dataString, BufferJSON.reviver);
      }
      return null;
    } catch (error) {
      console.error(`Falha ao ler ${key} do Upstash Redis`, error);
      return null;
    }
  };

  const writeData = async (key, data) => {
    try {
      // Serializa usando BufferJSON.replacer antes de salvar
      await redis.set(key, JSON.stringify(data, BufferJSON.replacer));
    } catch (error) {
      console.error(`Falha ao escrever ${key} no Upstash Redis`, error);
    }
  };

  const removeData = async (key) => {
    try {
      await redis.del(key);
    } catch (error) {
      console.error(`Falha ao deletar ${key} do Upstash Redis`, error);
    }
  };

  const creds = (await readData(AUTH_CREDS_REDIS_KEY)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const key = `${AUTH_KEYS_REDIS_PREFIX}_${type}_${id}`;
            let value = await readData(key);
            if (value) {
              if (type === 'app-state-sync-key' && value.keyData) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${AUTH_KEYS_REDIS_PREFIX}_${category}_${id}`;
              if (value) {
                tasks.push(writeData(key, value));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(AUTH_CREDS_REDIS_KEY, creds);
    },
  };
}

async function startBot() {
  const { state, saveCreds } = await useUpstashAuthState(); // Agora usa Upstash
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    // logger: require('pino')({ level: 'silent' })
  });

  let participants = [];

  const saveParticipantsToRedis = async () => {
    try {
      // O cliente @upstash/redis lida com JSON.stringify para objetos automaticamente
      await redis.set(PARTICIPANTS_REDIS_KEY, participants);
      console.log('Participantes salvos no Upstash Redis.');
    } catch (err) {
      console.error('Erro ao salvar participantes no Upstash Redis:', err);
    }
  };

  const loadParticipantsFromRedis = async () => {
    try {
      // O cliente @upstash/redis lida com JSON.parse para objetos automaticamente
      const data = await redis.get(PARTICIPANTS_REDIS_KEY);
      if (data && Array.isArray(data)) {
        participants = data;
        console.log('Participantes carregados do Upstash Redis:', participants.length);
      } else {
        participants = [];
        console.log('Nenhum participante encontrado no Upstash Redis, iniciando vazio.');
      }
    } catch (err) {
      participants = [];
      console.error('Erro ao carregar participantes do Upstash Redis, iniciando vazio:', err);
    }
  };

  await loadParticipantsFromRedis();

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('--- NOVO QR CODE --- (escaneie se necessário)');
      qrcode.generate(qr, { small: true });
      console.log('--- FIM QR CODE ---');
    }
    if (connection === 'close') {
      const boomError = lastDisconnect?.error ? new Boom(lastDisconnect.error) : undefined;
      const statusCode = boomError?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(
        'Conexão fechada:',
        statusCode,
        ', mensagem:', 
        boomError?.message,
        ', reconectar:',
        shouldReconnect
      );

      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log("Conexão substituída. Outra sessão foi aberta. Não vou reconectar.");
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log("Deslogado do WhatsApp. Limpando credenciais e não reconectando.");
        // Opcional: Limpar credenciais do Redis
        // async function clearAuth() { 
        //   await redis.del(AUTH_CREDS_REDIS_KEY);
        //   // E as chaves associadas...
        // }
        // clearAuth();
      } else if (shouldReconnect) {
        console.log('Tentando reconectar...');
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Bot conectado ao WhatsApp!');
      console.log('ID do Bot:', sock.user?.id);
    }
  });

  sock.ev.on('creds.update', saveCreds); // Salva credenciais no Upstash Redis

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderId = msg.key.participant || msg.key.remoteJid; 

    if (text.startsWith('@') && text.length > 1) {
      const participantName = text.slice(1).trim();
      if (participantName) {
        if (!participants.some(p => p.id === senderId)) {
          participants.push({ id: senderId, name: participantName });
          await saveParticipantsToRedis();
          await sock.sendMessage(chatId, { text: `🎉 @${participantName} (${senderId}) foi adicionado ao sorteio!`, mentions: [senderId] });
        } else {
          const existingParticipant = participants.find(p => p.id === senderId);
          await sock.sendMessage(chatId, { text: `🚫 @${existingParticipant.name} (${senderId}) já está participando!`, mentions: [senderId] });
        }
      } else {
        await sock.sendMessage(chatId, { text: '🚫 Por favor, envie um nome válido após @ (ex.: @Joao).', mentions: [senderId] });
      }
    }

    if (text.startsWith('!sortear')) {
      const botJid = sock.user?.id;
      if (!botJid || senderId.split('@')[0] !== botJid.split(':')[0].split('@')[0]) {
        await sock.sendMessage(chatId, { text: '🚫 Apenas o administrador pode usar o comando !sortear.' });
        return;
      }

      const args = text.split(' ');
      let numWinners = 1;
      if (args.length > 1 && !isNaN(args[1])) {
        numWinners = parseInt(args[1]);
      }

      if (participants.length === 0) {
        await sock.sendMessage(chatId, { text: '🚫 Nenhum participante no sorteio!' });
        return;
      }
      
      if (numWinners < 1) {
        await sock.sendMessage(chatId, { text: '🚫 O número de vencedores deve ser pelo menos 1.' });
        return;
      }

      numWinners = Math.min(numWinners, participants.length);

      const shuffled = [...participants].sort(() => 0.5 - Math.random());
      const winners = shuffled.slice(0, numWinners);
      const winnerMessages = winners.map(w => `@${w.name}`);
      const winnerJids = winners.map(w => w.id);

      await sock.sendMessage(chatId, { 
        text: `🏆 ${numWinners > 1 ? 'Os vencedores' : 'O vencedor'} do sorteio ${numWinners > 1 ? 'são' : 'é'}: ${winnerMessages.join(', ')}! Parabéns!`, 
        mentions: winnerJids 
      });

      participants = [];
      await saveParticipantsToRedis();
      await sock.sendMessage(chatId, { text: 'Lista de participantes resetada para o próximo sorteio!' });
    }
  });
}

startBot().catch((err) => {
  console.error('Erro crítico ao iniciar o bot:', err);
});
