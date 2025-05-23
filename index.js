// ----- INÍCIO DO SCRIPT api/index.js -----
console.log('[BOT_DEBUG] Script api/index.js iniciado.');

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

// Inicializa o cliente Redis
let redis;
try {
  redis = Redis.fromEnv();
  console.log('[BOT_DEBUG] Cliente Upstash Redis inicializado via fromEnv().');
} catch (e) {
  console.error('[BOT_ERROR] Falha ao inicializar cliente Redis fromEnv():', e);
  console.log('[BOT_DEBUG] Tentando inicializar cliente Redis com URLs explícitas (placeholder - ajuste se necessário):');
  // Fallback ou configuração explícita se fromEnv() falhar ou não for configurado
  // Lembre-se que as variáveis de ambiente são a forma preferida na Vercel.
  // Este bloco é mais para teste local se as env vars não estiverem setadas.
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[BOT_WARN] Variáveis de ambiente UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN não estão definidas!');
    // Você pode lançar um erro aqui se elas forem estritamente necessárias
    // throw new Error("Variáveis de ambiente do Redis não configuradas!");
  } else {
     // Se fromEnv() falhou mas as vars existem, o problema pode ser outro.
     console.log(`[BOT_DEBUG] UPSTASH_REDIS_REST_URL: ${process.env.UPSTASH_REDIS_REST_URL ? 'Definida' : 'NÃO DEFINIDA'}`);
     console.log(`[BOT_DEBUG] UPSTASH_REDIS_REST_TOKEN: ${process.env.UPSTASH_REDIS_REST_TOKEN ? 'Definida' : 'NÃO DEFINIDA'}`);
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
    if (!redis) {
      console.error('[BOT_ERROR] useUpstashAuthState.readData: Cliente Redis não inicializado!');
      return null;
    }
    try {
      const dataString = await redis.get(key);
      if (dataString) {
        console.log(`[BOT_DEBUG] useUpstashAuthState.readData: Dados encontrados para chave "${key}"`);
        return JSON.parse(dataString, BufferJSON.reviver);
      }
      console.log(`[BOT_DEBUG] useUpstashAuthState.readData: Nenhum dado para chave "${key}"`);
      return null;
    } catch (error) {
      console.error(`[BOT_ERROR] useUpstashAuthState.readData: Falha ao ler ${key}:`, error);
      return null;
    }
  };

  const writeData = async (key, data) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.writeData: Escrevendo chave "${key}"`);
    if (!redis) {
      console.error('[BOT_ERROR] useUpstashAuthState.writeData: Cliente Redis não inicializado!');
      return;
    }
    try {
      await redis.set(key, JSON.stringify(data, BufferJSON.replacer));
      console.log(`[BOT_DEBUG] useUpstashAuthState.writeData: Chave "${key}" escrita com sucesso.`);
    } catch (error) {
      console.error(`[BOT_ERROR] useUpstashAuthState.writeData: Falha ao escrever ${key}:`, error);
    }
  };

  const removeData = async (key) => {
    console.log(`[BOT_DEBUG] useUpstashAuthState.removeData: Removendo chave "${key}"`);
    if (!redis) {
      console.error('[BOT_ERROR] useUpstashAuthState.removeData: Cliente Redis não inicializado!');
      return;
    }
    try {
      await redis.del(key);
      console.log(`[BOT_DEBUG] useUpstashAuthState.removeData: Chave "${key}" removida com sucesso.`);
    } catch (error) {
      console.error(`[BOT_ERROR] useUpstashAuthState.removeData: Falha ao deletar ${key}:`, error);
    }
  };

  const creds = (await readData(AUTH_CREDS_REDIS_KEY)) || initAuthCreds();
  if (!creds.processedHistoryMessages) { // Exemplo de log para creds
      console.log('[BOT_DEBUG] useUpstashAuthState: Novas credenciais ou credenciais sem histórico processado.');
  } else {
      console.log('[BOT_DEBUG] useUpstashAuthState: Credenciais carregadas com histórico processado.');
  }
  console.log('[BOT_DEBUG] useUpstashAuthState: Credenciais carregadas/inicializadas.');

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          console.log(`[BOT_DEBUG] useUpstashAuthState.keys.get: Tipo "${type}", IDs "${ids.join(', ')}"`);
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
          console.log(`[BOT_DEBUG] useUpstashAuthState.keys.get: Dados retornados para tipo "${type}".`);
          return data;
        },
        set: async (data) => {
          console.log('[BOT_DEBUG] useUpstashAuthState.keys.set: Salvando dados de chaves.');
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
          console.log('[BOT_DEBUG] useUpstashAuthState.keys.set: Dados de chaves salvos.');
        },
      },
    },
    saveCreds: async () => {
      console.log('[BOT_DEBUG] useUpstashAuthState.saveCreds: Salvando credenciais principais.');
      await writeData(AUTH_CREDS_REDIS_KEY, creds);
      console.log('[BOT_DEBUG] useUpstashAuthState.saveCreds: Credenciais principais salvas.');
    },
  };
}

async function startBot() {
  console.log('[BOT_DEBUG] startBot: Iniciando função startBot...');
  if (!redis) {
    console.error('[BOT_ERROR] startBot: Cliente Redis não está disponível. Bot não pode iniciar.');
    return;
  }

  let state, saveCreds;
  try {
    console.log('[BOT_DEBUG] startBot: Chamando useUpstashAuthState...');
    const authResult = await useUpstashAuthState();
    state = authResult.state;
    saveCreds = authResult.saveCreds;
    console.log('[BOT_DEBUG] startBot: useUpstashAuthState retornado com sucesso.');
  } catch (e) {
    console.error('[BOT_ERROR] startBot: Erro ao chamar useUpstashAuthState:', e);
    return; // Não pode continuar sem auth state
  }

  console.log('[BOT_DEBUG] startBot: Chamando makeWASocket...');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    // logger: require('pino')({ level: 'trace' }) // Para debug extremo do Baileys, pode ser muito verboso
  });
  console.log('[BOT_DEBUG] startBot: makeWASocket chamado.');

  let participants = [];

  const saveParticipantsToRedis = async () => {
    console.log('[BOT_DEBUG] saveParticipantsToRedis: Salvando participantes...', participants);
    try {
      await redis.set(PARTICIPANTS_REDIS_KEY, participants);
      console.log('[BOT_DEBUG] saveParticipantsToRedis: Participantes salvos no Redis.');
    } catch (err) {
      console.error('[BOT_ERROR] saveParticipantsToRedis: Erro ao salvar:', err);
    }
  };

  const loadParticipantsFromRedis = async () => {
    console.log('[BOT_DEBUG] loadParticipantsFromRedis: Carregando participantes...');
    try {
      const data = await redis.get(PARTICIPANTS_REDIS_KEY);
      if (data && Array.isArray(data)) {
        participants = data;
        console.log('[BOT_DEBUG] loadParticipantsFromRedis: Participantes carregados:', participants);
      } else {
        participants = [];
        console.log('[BOT_DEBUG] loadParticipantsFromRedis: Nenhum participante encontrado, iniciando vazio.');
      }
    } catch (err) {
      participants = [];
      console.error('[BOT_ERROR] loadParticipantsFromRedis: Erro ao carregar:', err);
    }
  };

  console.log('[BOT_DEBUG] startBot: Carregando participantes iniciais...');
  await loadParticipantsFromRedis();

  sock.ev.on('connection.update', (update) => {
    console.log('[BOT_DEBUG] sock.ev("connection.update"): Evento recebido:', JSON.stringify(update));
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('[BOT_INFO] Novo QR code gerado. Escaneie com seu WhatsApp:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const boomError = lastDisconnect?.error ? new Boom(lastDisconnect.error) : undefined;
      const statusCode = boomError?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[BOT_INFO] Conexão fechada. Status: ${statusCode}, Erro: ${boomError?.message}, Reconectar: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log("[BOT_WARN] Conexão substituída. Outra sessão foi aberta.");
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log("[BOT_WARN] Deslogado do WhatsApp. Não vai reconectar. Limpe as credenciais se quiser novo QR.");
      } else if (shouldReconnect) {
        console.log('[BOT_INFO] Tentando reconectar...');
        startBot();
      }
    } else if (connection === 'open') {
      console.log('[BOT_INFO] Bot conectado ao WhatsApp!');
      console.log('[BOT_DEBUG] ID do Bot (sock.user):', JSON.stringify(sock.user));
    }
  });

  sock.ev.on('creds.update', () => {
    console.log('[BOT_DEBUG] sock.ev("creds.update"): Evento recebido. Chamando saveCreds...');
    saveCreds(); // saveCreds já tem seus próprios logs internos
    console.log('[BOT_DEBUG] sock.ev("creds.update"): saveCreds chamado.');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log('[BOT_DEBUG] sock.ev("messages.upsert"): Evento recebido:', JSON.stringify(messages));
    const msg = messages[0];
    if (!msg.message) {
      console.log('[BOT_DEBUG] Mensagem sem conteúdo (msg.message), ignorando.');
      return;
    }
    if (msg.key.fromMe) {
      console.log('[BOT_DEBUG] Mensagem de mim mesmo (fromMe), ignorando.');
      return;
    }

    const chatId = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderId = msg.key.participant || msg.key.remoteJid;
    console.log(`[BOT_DEBUG] Mensagem recebida: ChatID="${chatId}", SenderID="${senderId}", Texto="${text}"`);

    if (text.startsWith('@') && text.length > 1) {
      const participantName = text.slice(1).trim();
      console.log(`[BOT_DEBUG] Comando @ detectado: Nome="${participantName}"`);
      if (participantName) {
        const existingParticipant = participants.find(p => p.id === senderId);
        if (!existingParticipant) {
          participants.push({ id: senderId, name: participantName });
          await saveParticipantsToRedis();
          console.log(`[BOT_INFO] Participante @${participantName} (${senderId}) adicionado.`);
          await sock.sendMessage(chatId, { text: `🎉 @${participantName} foi adicionado ao sorteio!`, mentions: [senderId] });
        } else {
          console.log(`[BOT_INFO] Participante @${existingParticipant.name} (${senderId}) já está participando.`);
          await sock.sendMessage(chatId, { text: `🚫 @${existingParticipant.name} já está participando!`, mentions: [senderId] });
        }
      } else {
        console.log('[BOT_WARN] Comando @ recebido sem nome válido.');
        await sock.sendMessage(chatId, { text: '🚫 Por favor, envie um nome válido após @ (ex.: @Joao).', mentions: [senderId] });
      }
    }

    if (text.startsWith('!sortear')) {
      console.log('[BOT_DEBUG] Comando !sortear detectado.');
      const botJid = sock.user?.id;
      console.log(`[BOT_DEBUG] Verificando permissão: SenderID="${senderId}", BotJID="${botJid}"`);
      // Adapte esta lógica se necessário. Comparar apenas a parte numérica do JID.
      const senderNumericId = senderId.split('@')[0];
      const botNumericId = botJid ? botJid.split(':')[0].split('@')[0] : null;

      if (!botJid || senderNumericId !== botNumericId) {
         // Se quiser permitir um admin específico além do bot:
         // const adminJid = "SEU_NUMERO_DE_ADMIN@s.whatsapp.net";
         // const adminNumericId = adminJid.split('@')[0];
         // if (senderNumericId !== botNumericId && senderNumericId !== adminNumericId) {
        console.log('[BOT_WARN] Comando !sortear negado. Permissão insuficiente.');
        await sock.sendMessage(chatId, { text: '🚫 Apenas o administrador pode usar o comando !sortear.' });
        return;
      }
      console.log('[BOT_DEBUG] Permissão para !sortear concedida.');

      const args = text.split(' ');
      let numWinners = 1;
      if (args.length > 1 && !isNaN(args[1])) {
        numWinners = parseInt(args[1]);
      }
      console.log(`[BOT_DEBUG] Número de vencedores para sortear: ${numWinners}`);

      if (participants.length === 0) {
        console.log('[BOT_INFO] Tentativa de sorteio sem participantes.');
        await sock.sendMessage(chatId, { text: '🚫 Nenhum participante no sorteio!' });
        return;
      }
      
      if (numWinners < 1) {
        console.log('[BOT_WARN] Tentativa de sorteio com número de vencedores < 1.');
        await sock.sendMessage(chatId, { text: '🚫 O número de vencedores deve ser pelo menos 1.' });
        return;
      }

      numWinners = Math.min(numWinners, participants.length);
      console.log(`[BOT_DEBUG] Número de vencedores ajustado: ${numWinners} (Máx: ${participants.length})`);

      const shuffled = [...participants].sort(() => 0.5 - Math.random());
      const winners = shuffled.slice(0, numWinners);
      const winnerMessages = winners.map(w => `@${w.name}`);
      const winnerJids = winners.map(w => w.id);
      console.log('[BOT_INFO] Vencedores sorteados:', JSON.stringify(winners));

      await sock.sendMessage(chatId, { 
        text: `🏆 ${numWinners > 1 ? 'Os vencedores' : 'O vencedor'} do sorteio ${numWinners > 1 ? 'são' : 'é'}: ${winnerMessages.join(', ')}! Parabéns!`, 
        mentions: winnerJids 
      });
      console.log('[BOT_INFO] Mensagem de vencedores enviada.');

      participants = [];
      await saveParticipantsToRedis();
      console.log('[BOT_INFO] Lista de participantes resetada.');
      await sock.sendMessage(chatId, { text: 'Lista de participantes resetada para o próximo sorteio!' });
    }
  });
  console.log('[BOT_DEBUG] startBot: Handlers de eventos configurados.');
}

console.log('[BOT_DEBUG] Chamando startBot() pela primeira vez...');
startBot().catch((err) => {
  console.error('[BOT_FATAL] Erro crítico não tratado ao iniciar o bot:', err);
});

console.log('[BOT_DEBUG] ----- FIM DO SCRIPT api/index.js (setup inicial) -----');

// Se estiver usando Vercel com um handler exportado (como em um projeto Next.js ou serverless puro):
// module.exports = (req, res) => {
//   console.log('[BOT_DEBUG] Handler de requisição Vercel chamado.');
//   // A lógica de iniciar o bot uma vez e mantê-lo pode ser complexa aqui.
//   // O startBot() acima já é chamado na inicialização do script.
//   // Esta função de handler pode não ser ideal para um bot de longa duração.
//   res.status(200).send('Bot em execução (verifique os logs para status).');
// };
